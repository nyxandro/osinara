/**
 * PostgreSQL integration tests of a monitor: a conversation wake-up whose check runs without the model.
 *
 * Constructs covered:
 * - A monitor exists only as a conversation wake-up; the database refuses a faster or isolated one.
 * - A tick that does not wake the agent keeps no run, spends no limit, and plans the next check;
 *   broken checks count in a row, and a replaced script starts over.
 * - An event queues a wake-up whose turn receives why it woke and what the check printed.
 * - The next check never lands after the window; the run due at it ends the monitor.
 * - A conversation the chat left behind parks the monitor without running its check.
 * - A closed window refuses to run or resume until it is moved.
 * - Its own wake-up turn may fix the check while the schedule is busy, nothing else may; a check is
 *   changed only from the chat it watches, and a call already applied is reported as replayed.
 * - A check that could not run keeps the last check time; six in a row raise one owner incident.
 * - The tick of an author who left the family is refused.
 * - A monitor's tick is claimed only by the check cycle, never by the scenario dispatcher.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationWakeupRepository } from "../conversation-wakeups/conversation-wakeup-repository.js";
import { conversationWakeupRunRepository } from "../conversation-wakeups/conversation-wakeup-run-repository.js";
import { CONVERSATION_CHANGED_CODE } from "../conversation-wakeups/conversation-wakeup-transitions.js";
import { conversationCanonicalRouteToken } from "../conversation-wakeups/conversation-wakeup-turn.js";
import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import { NO_BURSTS } from "../telegram-ingress.test-fixtures.js";
import { scheduleCheckRepository } from "./agent-schedule-check-repository.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled && (!integrationDatabaseUrl || !new URL(integrationDatabaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const LEASE = 60_000;
const CHECK = "curl -s https://clinic.example/slots | grep -q ноябрь && echo открыта || true";
const minutes = (count: number) => new Date(Date.now() + count * 60_000);
const QUIET = { checked: true, errorCode: null, failures: 0, unavailable: 0 };

describeWithDatabase("schedule monitors", () => {
  let auth: AgentScheduleAuthorization;
  let sessionId: string;

  async function createMonitor(overrides: Partial<Parameters<typeof agentScheduleRepository.create>[1]> = {}) {
    return await agentScheduleRepository.create(auth, {
      checkCommand: CHECK,
      checkUntil: minutes(2 * 24 * 60),
      executionContext: "conversation",
      firstRunAt: minutes(-1),
      maxRuns: 5,
      operationKey: `create-${Math.random()}`,
      recurrence: { interval: 10, kind: "minutely" },
      scenarioPrompt: "Проверь, открылась ли запись на ноябрь, и сообщи",
      scope: "personal",
      timezone: "Europe/Moscow",
      title: "Запись к врачу",
      userRequest: "Скажи, когда откроется запись на ноябрь",
      ...overrides,
    });
  }

  async function claimTick() {
    const [job] = await agentScheduleDispatchRepository.claimDueMonitors({ leaseMilliseconds: LEASE, limit: 10, now: new Date() });
    expect(job?.monitor).toBe(true);
    return job!;
  }

  async function scheduleState(id: string) {
    return (await database().query(
      `SELECT status, completed_runs, check_failures, last_check_error_code, last_checked_at IS NOT NULL AS checked,
              next_run_at, check_until, last_error_code,
              (SELECT count(*)::int FROM agent_schedule_runs WHERE schedule_id = $1) AS runs
         FROM agent_schedules WHERE id = $1`,
      [id],
    )).rows[0];
  }

  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_ingress_wakeups, agent_schedule_runs, agent_schedule_operations, agent_schedules,
         telegram_turn_interjections, telegram_ingress_ignored_updates,
         telegram_ingress_updates, telegram_ingress_continuation_aliases, telegram_ingress_queues,
         conversation_session_routes, conversation_sessions, conversation_route_generations,
         application_conversations, family_memberships, users, families, operational_incidents, agent_session_state CASCADE`,
    );
    const familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Мониторы') RETURNING id")).rows[0]!.id;
    const userId = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Владелец') RETURNING id",
    )).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::", familyId, groupId: null, kind: "canonical", now: new Date(),
      scope: "personal", telegramForumTopicId: null, userId,
    });
    sessionId = session.id;
    await sessionRepository.bindAgentSession(sessionId, "ses_agent_1");
    await telegramIngressRepository.enqueue({
      continuationKey: "101::",
      payload: {
        message: { chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false }, message_id: 1000, text: "следи за записью" },
        update_id: 1000,
      },
      updateId: "1000",
    });
    const claim = await telegramIngressRepository.claimNext(LEASE, NO_BURSTS);
    await telegramIngressRepository.complete(claim!.updateId, claim!.leaseToken);
    auth = {
      applicationSessionId: sessionId, familyId, forumTopicId: null, groupId: null, groupType: null,
      messageThreadId: null, role: "owner", telegramChatId: "101", telegramChatType: "private",
      telegramUpdateId: "1000", telegramUserId: "101", userId,
    };
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("exists only as a conversation wake-up checking at most every five minutes", async () => {
    const monitor = await createMonitor();
    expect(monitor.check).toMatchObject({ command: CHECK, consecutiveFailures: 0, lastCheckedAt: null });

    await expect(database().query("UPDATE agent_schedules SET recurrence_interval = 2 WHERE id = $1", [monitor.id]))
      .rejects.toThrow(/agent_schedule_check_shape/u);
    await expect(database().query(
      "UPDATE agent_schedules SET execution_context = 'isolated', conversation_session_id = NULL, ingress_queue_id = NULL WHERE id = $1",
      [monitor.id],
    )).rejects.toThrow(/agent_schedule_check_shape/u);
  });

  it("keeps no run and spends no limit on a quiet tick, then plans the next check", async () => {
    const monitor = await createMonitor();
    const tick = await claimTick();

    const target = await scheduleCheckRepository.loadTarget(tick);
    expect(target).toMatchObject({ checkCommand: CHECK, sandbox: { agentSessionId: "ses_agent_1", applicationSessionId: sessionId } });
    await scheduleCheckRepository.finishTick(tick, QUIET, new Date());

    const state = await scheduleState(monitor.id);
    expect(state).toMatchObject({ checked: true, completed_runs: 0, runs: 0, status: "active" });
    expect(state.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("counts broken checks in a row and starts over for a replaced script", async () => {
    const monitor = await createMonitor();
    const tick = await claimTick();
    await scheduleCheckRepository.loadTarget(tick);
    await scheduleCheckRepository.finishTick(tick, { checked: true, errorCode: "AGENT_SCHEDULE_CHECK_FAILED", failures: 2, unavailable: 0 }, new Date());
    expect(await scheduleState(monitor.id)).toMatchObject({ check_failures: 2, last_check_error_code: "AGENT_SCHEDULE_CHECK_FAILED" });

    await agentScheduleRepository.update(auth, monitor.id, { checkCommand: `${CHECK} -i`, operationKey: "fix-check" });

    expect(await scheduleState(monitor.id)).toMatchObject({ check_failures: 0, last_check_error_code: null });
  });

  it("queues a wake-up whose turn learns why it woke and what the check printed", async () => {
    const monitor = await createMonitor();
    const tick = await claimTick();
    await scheduleCheckRepository.loadTarget(tick);

    expect(await scheduleCheckRepository.wake(tick, { output: "открыта на 12 ноября", trigger: "fired" }, QUIET, new Date()))
      .toBe("queued");
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    const prepared = await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);

    expect(prepared).toMatchObject({
      kind: "ready",
      wakeup: { check: { last: false, output: "открыта на 12 ноября", trigger: "fired" }, scheduleId: monitor.id },
    });
  });

  it("never plans a check after the window and ends the monitor with the run due at it", async () => {
    const monitor = await createMonitor({ checkUntil: minutes(3) });
    const first = await claimTick();
    await scheduleCheckRepository.loadTarget(first);
    await scheduleCheckRepository.finishTick(first, QUIET, new Date());
    const clamped = await scheduleState(monitor.id);
    expect(clamped.next_run_at.getTime()).toBe(clamped.check_until.getTime());

    // The window's end has come: its tick is the last one.
    await database().query(
      "UPDATE agent_schedules SET check_until = date_trunc('milliseconds', now()) - interval '1 second', next_run_at = date_trunc('milliseconds', now()) - interval '1 second' WHERE id = $1",
      [monitor.id],
    );
    const last = await claimTick();
    await scheduleCheckRepository.loadTarget(last);
    await scheduleCheckRepository.wake(last, { output: null, trigger: "expired" }, QUIET, new Date());
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    const prepared = await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    expect(prepared).toMatchObject({ wakeup: { check: { last: true, trigger: "expired" } } });
    await conversationWakeupRepository.bindDispatch(database(), claim!, {
      admissionDeadlineAt: minutes(5), id: randomUUID(), sessionId: "ses_agent_1", turnId: "turn_last",
    });
    const turn = { applicationSessionId: sessionId, agentSessionId: "ses_agent_1", agentTurnId: "turn_9", runId: last.runId };
    await conversationWakeupRunRepository.admitTurn(turn);
    expect(await conversationWakeupRunRepository.finishTurn({ ...turn, completedAt: new Date(), failureCode: null })).toBe(true);

    expect(await scheduleState(monitor.id)).toMatchObject({ completed_runs: 1, status: "completed" });
  });

  it("parks a monitor whose conversation the chat left behind without checking", async () => {
    const monitor = await createMonitor();
    const tick = await claimTick();
    await database().query("UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [sessionId]);

    expect(await scheduleCheckRepository.loadTarget(tick)).toBeNull();

    expect(await scheduleState(monitor.id)).toMatchObject({ last_error_code: CONVERSATION_CHANGED_CODE, runs: 0, status: "paused" });
  });

  it("refuses to run or resume after its window closed until the window moves", async () => {
    const monitor = await createMonitor();
    await agentScheduleRepository.update(auth, monitor.id, { enabled: false, operationKey: "pause" });
    await database().query("UPDATE agent_schedules SET check_until = now() - interval '1 minute' WHERE id = $1", [monitor.id]);

    await expect(agentScheduleRepository.runNow(auth, monitor.id, "run-now")).rejects.toThrow("AGENT_SCHEDULE_CHECK_WINDOW_CLOSED");
    await expect(agentScheduleRepository.update(auth, monitor.id, { enabled: true, operationKey: "resume" }))
      .rejects.toThrow("AGENT_SCHEDULE_CHECK_WINDOW_CLOSED");
    await agentScheduleRepository.update(auth, monitor.id, { checkUntil: minutes(24 * 60), operationKey: "extend" });
    await expect(agentScheduleRepository.update(auth, monitor.id, { enabled: true, operationKey: "resume-2" }))
      .resolves.toMatchObject({ status: "active" });
  });

  it("is claimed by the check cycle only, never by the scenario dispatcher", async () => {
    await createMonitor();

    expect(await agentScheduleDispatchRepository.claimDue({ leaseMilliseconds: LEASE, limit: 10, now: new Date() })).toEqual([]);
    expect(await claimTick()).toMatchObject({ monitor: true });
  });

  it("lets its own wake-up turn fix the check while the schedule is busy, and nothing else", async () => {
    const monitor = await createMonitor();
    const tick = await claimTick();
    await scheduleCheckRepository.loadTarget(tick);
    await scheduleCheckRepository.wake(tick, { output: "exit code 6: curl", trigger: "failed" }, QUIET, new Date());
    const wakeTurn = { ...auth, wakeupScheduleId: monitor.id };

    await expect(agentScheduleRepository.update(wakeTurn, monitor.id, { checkCommand: `${CHECK} -i`, operationKey: "fix" }))
      .resolves.toMatchObject({ check: { command: `${CHECK} -i` }, status: "leased" });
    await expect(agentScheduleRepository.update(wakeTurn, monitor.id, {
      operationKey: "slower", recurrence: { interval: 30, kind: "minutely" },
    })).rejects.toThrow("AGENT_SCHEDULE_RUN_IN_PROGRESS");
    await expect(agentScheduleRepository.update(auth, monitor.id, { operationKey: "other", scenarioPrompt: "Другая заметка" }))
      .rejects.toThrow("AGENT_SCHEDULE_RUN_IN_PROGRESS");
    await expect(scheduleCheckRepository.prepareChange(auth, { id: monitor.id, operationKey: "busy" }))
      .rejects.toThrow("AGENT_SCHEDULE_RUN_IN_PROGRESS");
    expect(await scheduleCheckRepository.prepareChange(wakeTurn, { id: monitor.id, operationKey: "fix-2" })).toBe("ready");
  });

  it("changes a check only from the chat it watches and reports a call already applied", async () => {
    const monitor = await createMonitor();
    const elsewhere: AgentScheduleAuthorization = { ...auth, telegramChatId: "202" };

    await expect(agentScheduleRepository.update(elsewhere, monitor.id, { checkCommand: "true", operationKey: "foreign" }))
      .rejects.toThrow("AGENT_SCHEDULE_CHECK_CHAT_MISMATCH");
    await expect(scheduleCheckRepository.prepareChange(elsewhere, { id: monitor.id, operationKey: "foreign-2" }))
      .rejects.toThrow("AGENT_SCHEDULE_CHECK_CHAT_MISMATCH");
    expect(await scheduleCheckRepository.prepareChange(auth, { id: monitor.id, operationKey: "own" })).toBe("ready");
    await agentScheduleRepository.update(auth, monitor.id, { checkUntil: minutes(24 * 60), operationKey: "applied" });
    expect(await scheduleCheckRepository.prepareChange(auth, { id: monitor.id, operationKey: "applied" })).toBe("replayed");
  });

  it("keeps the last check time when the check could not run and tells the owner after six in a row", async () => {
    const monitor = await createMonitor();
    for (let unavailable = 1; unavailable <= 7; unavailable += 1) {
      await database().query("UPDATE agent_schedules SET next_run_at = now() - interval '1 second' WHERE id = $1", [monitor.id]);
      const tick = await claimTick();
      await scheduleCheckRepository.loadTarget(tick);
      await scheduleCheckRepository.finishTick(tick, {
        checked: false, errorCode: "AGENT_SCHEDULE_CHECK_UNAVAILABLE", failures: 0, unavailable,
      }, new Date());
    }

    expect(await scheduleState(monitor.id)).toMatchObject({ checked: false, last_check_error_code: "AGENT_SCHEDULE_CHECK_UNAVAILABLE" });
    const incidents = await database().query("SELECT 1 FROM operational_incidents WHERE code = 'AGENT_SCHEDULE_CHECK_UNAVAILABLE'");
    expect(incidents.rowCount).toBe(1);
  });

  it("refuses the tick of an author who left the family", async () => {
    await createMonitor();
    const tick = await claimTick();
    await database().query("DELETE FROM family_memberships");

    await expect(scheduleCheckRepository.loadTarget(tick)).rejects.toThrow("AGENT_SCHEDULE_DESTINATION_REVOKED");
  });
});
