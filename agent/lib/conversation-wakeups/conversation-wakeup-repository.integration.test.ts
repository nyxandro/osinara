/**
 * PostgreSQL integration tests for wake-ups that run inside a chat's own conversation.
 *
 * Constructs covered:
 * - A conversation schedule binds to the conversation and chat queue of the turn that creates it;
 *   it needs a run limit, and a chat holds at most three active ones.
 * - A due occurrence waits in the chat queue behind that chat's messages, then holds the queue
 *   against new messages until it completes; the scheduler's recoveries never touch it meanwhile.
 * - A crashed wake-up is reclaimed even when messages already wait behind it.
 * - Preparation revalidates the conversation: a pause withdraws the run, a new or failed
 *   conversation parks it, a pending approval defers it, a schedule that no longer waits closes it.
 * - A dispatched wake-up that loses its lease is reclaimed with its dispatch coordinates, never resent.
 * - A handoff that never started parks the schedule unless a turn was admitted meanwhile.
 * - The turn's completion counts the execution; a second wake-up of the same conversation runs too.
 * - A wake-up still waiting in the queue, or one that already ended, can be deleted with its schedule.
 * - Every terminal transition frees the chat's lane mark, and a claim in flight on the chat queue
 *   keeps the other kind of claim out.
 * - A turn refused before admission parks its wake-up; only the run's own turn closes the run.
 * - The scheduler's sweep closes a run whose item ended: unstarted past its deadline, or lost.
 * - The planned-wakeups block lists the author's open and self-paused wake-ups only.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { agentScheduleDispatchRepository } from "../agent-schedules/agent-schedule-dispatch-repository.js";
import type { AgentScheduleAuthorization } from "../agent-schedules/agent-schedule-context.js";
import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import { conversationWakeupContextRepository } from "./conversation-wakeup-context.js";
import { conversationWakeupRepository } from "./conversation-wakeup-repository.js";
import { CONVERSATION_CHANGED_CODE } from "./conversation-wakeup-transitions.js";
import { conversationWakeupRunRepository } from "./conversation-wakeup-run-repository.js";
import { conversationCanonicalRouteToken } from "./conversation-wakeup-turn.js";
import { NO_BURSTS } from "../telegram-ingress.test-fixtures.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled && (!integrationDatabaseUrl || !new URL(integrationDatabaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const LEASE = 60_000;

async function enqueueMessage(updateId: string, text = `text ${updateId}`) {
  await telegramIngressRepository.enqueue({
    continuationKey: "101::",
    payload: {
      message: { chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false }, message_id: Number(updateId), text },
      update_id: Number(updateId),
    },
    updateId,
  });
}

// The exact readiness query the deploy runs before it stops services.
const deployReadinessSql = /app_idle="\$\(psql_current <<'SQL'\n([\s\S]*?)\nSQL/u.exec(
  readFileSync(new URL("../../../scripts/production-deploy/backup.sh", import.meta.url), "utf8"),
)?.[1];

async function deployReadiness(): Promise<unknown> {
  if (!deployReadinessSql) throw new Error("TEST_DEPLOY_READINESS_SQL_MISSING");
  return Object.values((await database().query(deployReadinessSql)).rows[0])[0];
}

function handoff(admissionDeadlineAt = new Date(Date.now() + 5 * 60_000)) {
  return { admissionDeadlineAt, id: randomUUID() };
}

async function laneMark(): Promise<string | null> {
  const queue = await database().query<{ active_wakeup_id: string | null }>(
    "SELECT active_wakeup_id::text FROM telegram_ingress_queues WHERE current_continuation_key = '101::'",
  );
  return queue.rows[0]!.active_wakeup_id;
}

async function finishMessage(updateId: string) {
  const claim = await telegramIngressRepository.claimNext(LEASE, NO_BURSTS);
  expect(claim?.updateId).toBe(updateId);
  await telegramIngressRepository.complete(claim!.updateId, claim!.leaseToken);
}

describeWithDatabase("conversation wake-ups", () => {
  let auth: AgentScheduleAuthorization;
  let sessionId: string;
  let familyId: string;

  async function createWakeup(overrides: Partial<Parameters<typeof agentScheduleRepository.create>[1]> = {}) {
    return await agentScheduleRepository.create(auth, {
      executionContext: "conversation",
      firstRunAt: new Date(Date.now() - 60_000),
      maxRuns: 3,
      operationKey: `create-${Math.random()}`,
      recurrence: { interval: 10, kind: "minutely" },
      scenarioPrompt: "Проверь статус заказа 6426132 и сообщи, если приехал",
      scope: "personal",
      timezone: "Europe/Moscow",
      title: "Доставка кофе",
      userRequest: "Скажи, когда привезут кофе",
      ...overrides,
    });
  }

  async function queueDue() {
    const [job] = await agentScheduleDispatchRepository.claimDue({ leaseMilliseconds: LEASE, limit: 10, now: new Date() });
    expect(job?.executionContext).toBe("conversation");
    expect(await conversationWakeupRepository.enqueue(job!)).toBe("queued");
    return job!;
  }

  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_ingress_wakeups, agent_schedule_runs, agent_schedule_operations, agent_schedules,
         telegram_turn_interjections, eve_session_event_cursors, telegram_ingress_ignored_updates,
         telegram_ingress_updates, telegram_ingress_continuation_aliases, telegram_ingress_queues,
         conversation_session_routes, conversation_sessions, conversation_route_generations,
         application_conversations, family_memberships, users, families, operational_incidents CASCADE`,
    );
    familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Пробуждения') RETURNING id")).rows[0]!.id;
    const userId = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Владелец') RETURNING id",
    )).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::", familyId, groupId: null, kind: "canonical", now: new Date(),
      scope: "personal", telegramForumTopicId: null, userId,
    });
    sessionId = session.id;
    await sessionRepository.bindEveSession(sessionId, "ses_eve_1");
    await enqueueMessage("1000", "закажи кофе");
    await finishMessage("1000");
    auth = {
      applicationSessionId: sessionId, familyId, forumTopicId: null, groupId: null, groupType: null,
      messageThreadId: null, role: "owner", telegramChatId: "101", telegramChatType: "private",
      telegramUpdateId: "1000", telegramUserId: "101", userId,
    };
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("binds to the creating conversation, needs a run limit and allows three per chat", async () => {
    const schedule = await createWakeup();
    expect(schedule.executionContext).toBe("conversation");
    const bound = await database().query("SELECT conversation_session_id::text FROM agent_schedules WHERE id = $1", [schedule.id]);
    expect(bound.rows[0].conversation_session_id).toBe(sessionId);

    await expect(createWakeup({ maxRuns: null })).rejects.toThrow("AGENT_SCHEDULE_CONVERSATION_LIMIT_REQUIRED");
    await createWakeup();
    await createWakeup();
    await expect(createWakeup()).rejects.toThrow("AGENT_SCHEDULE_CONVERSATION_LIMIT_REACHED");

    const { telegramUpdateId: _updateId, ...withoutUpdate } = auth;
    auth = withoutUpdate;
    await expect(createWakeup()).rejects.toThrow("AGENT_SCHEDULE_CONVERSATION_UNAVAILABLE");
  });

  it("waits behind the chat's messages, then holds the chat until it completes", async () => {
    await createWakeup();
    await enqueueMessage("1001");
    const job = await queueDue();

    expect(await conversationWakeupRepository.claimNext(LEASE)).toBeNull();
    await finishMessage("1001");
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    expect(claim).toMatchObject({ dispatch: null, eveTurnId: null, runId: job.runId, scheduleId: job.id });
    expect(await laneMark()).toBe(claim!.id);

    await enqueueMessage("1002");
    expect(await telegramIngressRepository.claimNext(LEASE, NO_BURSTS)).toBeNull();

    const prepared = await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    expect(prepared).toMatchObject({
      kind: "ready",
      wakeup: { applicationSessionId: sessionId, eveSessionId: "ses_eve_1", maxRuns: 3, telegramUserId: "101" },
    });
    expect(await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", handoff())).toBe(0);
    await conversationWakeupRepository.complete(claim!, "ses_eve_1", 7);
    expect(await laneMark()).toBeNull();

    const cursor = await database().query("SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id = 'ses_eve_1'");
    expect(Number(cursor.rows[0].next_event_index)).toBe(7);
    expect((await telegramIngressRepository.claimNext(LEASE, NO_BURSTS))?.updateId).toBe("1002");
  });

  it("is left alone by the scheduler's own recoveries while it waits", async () => {
    await createWakeup();
    await enqueueMessage("1001");
    const job = await queueDue();

    await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: LEASE, limit: 10, now: new Date(Date.now() + 24 * 60 * 60_000),
    });

    const state = await database().query(
      "SELECT schedule.status, run.status AS run_status FROM agent_schedules schedule JOIN agent_schedule_runs run ON run.schedule_id = schedule.id WHERE schedule.id = $1",
      [job.id],
    );
    expect(state.rows[0]).toMatchObject({ run_status: "dispatching", status: "leased" });
  });

  it("withdraws a paused wake-up and parks one whose conversation changed", async () => {
    const paused = await createWakeup();
    const job = await queueDue();
    await agentScheduleRepository.update(auth, paused.id, { enabled: false, operationKey: "pause" });
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    expect(await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken)).toEqual({ kind: "withdrawn" });
    const afterPause = await database().query(
      "SELECT status, last_error_code, (SELECT count(*)::int FROM agent_schedule_runs WHERE schedule_id = $1) AS runs FROM agent_schedules WHERE id = $1",
      [job.id],
    );
    expect(afterPause.rows[0]).toMatchObject({ last_error_code: null, runs: 0, status: "paused" });

    const changed = await createWakeup();
    await queueDue();
    // The chat started a new conversation after the wake-up was planned.
    await database().query("UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [sessionId]);
    const next = await conversationWakeupRepository.claimNext(LEASE);
    expect(await conversationWakeupRepository.prepare(next!, conversationCanonicalRouteToken)).toEqual({ kind: "withdrawn" });
    const parked = await database().query("SELECT status, last_error_code FROM agent_schedules WHERE id = $1", [changed.id]);
    expect(parked.rows[0]).toEqual({ last_error_code: CONVERSATION_CHANGED_CODE, status: "paused" });
  });

  it("reclaims a dispatched wake-up with its start coordinate instead of sending it again", async () => {
    await createWakeup();
    await queueDue();
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    const dispatched = handoff();
    await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", dispatched);
    await database().query("UPDATE telegram_ingress_wakeups SET lease_expires_at = now() - interval '1 second'");

    expect(await conversationWakeupRepository.claimNext(LEASE)).toMatchObject({
      dispatch: { admissionDeadlineAt: dispatched.admissionDeadlineAt, eveSessionId: "ses_eve_1", id: dispatched.id, startIndex: 0 },
      id: claim!.id,
    });
  });

  it("counts the execution when the turn completes and schedules the next one", async () => {
    await createWakeup();
    const job = await queueDue();
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", handoff());
    const turn = { applicationSessionId: sessionId, eveSessionId: "ses_eve_1", eveTurnId: "turn_4", runId: job.runId };
    await conversationWakeupRunRepository.admitTurn(turn);

    expect(await conversationWakeupRunRepository.finishTurn({ ...turn, completedAt: new Date(), failureCode: null })).toBe(true);
    expect(await conversationWakeupRunRepository.finishTurn({ ...turn, completedAt: new Date(), failureCode: null })).toBe(false);

    const state = await database().query(
      "SELECT status, completed_runs, next_run_at > now() AS future FROM agent_schedules WHERE id = $1",
      [job.id],
    );
    expect(state.rows[0]).toMatchObject({ completed_runs: 1, future: true, status: "active" });
    const run = await database().query("SELECT status FROM agent_schedule_runs WHERE id = $1", [job.runId]);
    expect(run.rows[0].status).toBe("completed");
  });

  it("deletes a wake-up that still waits in the queue together with its schedule", async () => {
    const schedule = await createWakeup();
    await queueDue();

    expect(await agentScheduleRepository.delete(auth, schedule.id, "delete")).toBe(true);
    const left = await database().query("SELECT count(*)::int AS count FROM telegram_ingress_wakeups");
    expect(left.rows[0].count).toBe(0);
  });

  it("reclaims a crashed wake-up although messages already wait behind it", async () => {
    await createWakeup();
    await queueDue();
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    await enqueueMessage("1001");
    await database().query("UPDATE telegram_ingress_wakeups SET lease_expires_at = now() - interval '1 second'");

    // The wake-up still owns the lane, so only its own recovery can free it for the message.
    expect(await telegramIngressRepository.claimNext(LEASE, NO_BURSTS)).toBeNull();
    expect((await conversationWakeupRepository.claimNext(LEASE))?.id).toBe(claim!.id);
  });

  it("parks a wake-up whose conversation failed and defers one that waits for an approval", async () => {
    const failed = await createWakeup();
    await queueDue();
    await database().query("UPDATE conversation_sessions SET rotation_requested_at = now() WHERE id = $1", [sessionId]);
    const first = await conversationWakeupRepository.claimNext(LEASE);
    expect(await conversationWakeupRepository.prepare(first!, conversationCanonicalRouteToken)).toEqual({ kind: "withdrawn" });
    const parked = await database().query("SELECT status, last_error_code FROM agent_schedules WHERE id = $1", [failed.id]);
    expect(parked.rows[0]).toEqual({ last_error_code: CONVERSATION_CHANGED_CODE, status: "paused" });
    expect(await laneMark()).toBeNull();

    await database().query("UPDATE conversation_sessions SET rotation_requested_at = NULL, pending_operation = true WHERE id = $1", [sessionId]);
    const waiting = await createWakeup();
    const job = await queueDue();
    const second = await conversationWakeupRepository.claimNext(LEASE);
    expect(await conversationWakeupRepository.prepare(second!, conversationCanonicalRouteToken)).toEqual({ kind: "deferred" });
    const deferred = await database().query(
      "SELECT status, available_at > now() AS later FROM telegram_ingress_wakeups WHERE run_id = $1",
      [job.runId],
    );
    expect(deferred.rows[0]).toEqual({ later: true, status: "pending" });
    expect(await laneMark()).toBeNull();
    expect(await conversationWakeupRepository.claimNext(LEASE)).toBeNull();
    const schedule = await database().query("SELECT status FROM agent_schedules WHERE id = $1", [waiting.id]);
    expect(schedule.rows[0].status).toBe("leased");
  });

  it("closes a claimed wake-up whose schedule no longer waits for it", async () => {
    await createWakeup();
    const job = await queueDue();
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    await database().query(
      "UPDATE agent_schedules SET status = 'active', lease_token = NULL, lease_expires_at = NULL, dispatch_started_at = NULL WHERE id = $1",
      [job.id],
    );

    expect(await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken)).toEqual({ kind: "withdrawn" });
    const item = await database().query("SELECT status, last_error_code FROM telegram_ingress_wakeups WHERE id = $1", [claim!.id]);
    expect(item.rows[0]).toEqual({ last_error_code: "AGENT_CONVERSATION_WAKEUP_STALE", status: "failed" });
    expect(await laneMark()).toBeNull();
  });

  it("parks a handoff that never started unless a turn was admitted meanwhile", async () => {
    const schedule = await createWakeup();
    const job = await queueDue();
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", handoff());

    expect(await conversationWakeupRepository.withdrawNotStarted(claim!, "AGENT_CONVERSATION_WAKEUP_NOT_STARTED")).toBe(true);
    const parked = await database().query("SELECT status, last_error_code FROM agent_schedules WHERE id = $1", [schedule.id]);
    expect(parked.rows[0]).toEqual({ last_error_code: "AGENT_CONVERSATION_WAKEUP_NOT_STARTED", status: "paused" });
    expect(await laneMark()).toBeNull();
    // A turn that still arrives finds no run to admit it and stops before the model.
    await expect(conversationWakeupRunRepository.admitTurn({
      applicationSessionId: sessionId, eveSessionId: "ses_eve_1", eveTurnId: "turn_4", runId: job.runId,
    })).rejects.toThrow("AGENT_SCHEDULE_ATTEMPT_STALE");

    await agentScheduleRepository.update(auth, schedule.id, { enabled: true, operationKey: "resume" });
    await database().query("UPDATE agent_schedules SET next_run_at = now() - interval '1 second' WHERE id = $1", [schedule.id]);
    const again = await queueDue();
    const next = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(next!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(next!, "ses_eve_1", handoff());
    await conversationWakeupRunRepository.admitTurn({
      applicationSessionId: sessionId, eveSessionId: "ses_eve_1", eveTurnId: "turn_6", runId: again.runId,
    });
    expect(await conversationWakeupRepository.withdrawNotStarted(next!, "AGENT_CONVERSATION_WAKEUP_NOT_STARTED")).toBe(false);
    expect(await conversationWakeupRepository.admittedTurn(again.runId)).toEqual({ eveTurnId: "turn_6", open: true });
  });

  it("runs a second wake-up of the same conversation after the first one", async () => {
    const schedule = await createWakeup();
    for (const [index, eveTurnId] of ["turn_4", "turn_6"].entries()) {
      if (index > 0) {
        await database().query("UPDATE agent_schedules SET next_run_at = now() - interval '1 second' WHERE id = $1", [schedule.id]);
      }
      const job = await queueDue();
      const claim = await conversationWakeupRepository.claimNext(LEASE);
      await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
      await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", handoff());
      const turn = { applicationSessionId: sessionId, eveSessionId: "ses_eve_1", eveTurnId, runId: job.runId };
      await conversationWakeupRunRepository.admitTurn(turn);
      expect(await conversationWakeupRunRepository.finishTurn({ ...turn, completedAt: new Date(), failureCode: null })).toBe(true);
      await conversationWakeupRepository.complete(claim!, "ses_eve_1", 10 * (index + 1));
    }
    const state = await database().query("SELECT completed_runs FROM agent_schedules WHERE id = $1", [schedule.id]);
    expect(state.rows[0].completed_runs).toBe(2);
  });

  it("deletes a schedule whose wake-up already ended but keeps a running one", async () => {
    const schedule = await createWakeup();
    await queueDue();
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", handoff());

    await expect(agentScheduleRepository.delete(auth, schedule.id, "delete-running")).rejects.toThrow("AGENT_SCHEDULE_RUN_IN_PROGRESS");
    // The observer lost the turn: the item is terminal while the run still waits for a turn that may never end.
    await conversationWakeupRepository.fail(claim!, { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "lost" });
    expect(await laneMark()).toBeNull();
    expect(await agentScheduleRepository.delete(auth, schedule.id, "delete-ended")).toBe(true);
  });

  it("caps a conversation schedule at fifty runs and keeps its limit on update", async () => {
    await expect(createWakeup({ maxRuns: 51 })).rejects.toThrow("AGENT_SCHEDULE_CONVERSATION_LIMIT_TOO_HIGH");
    const schedule = await createWakeup({ maxRuns: 50 });
    await expect(agentScheduleRepository.update(auth, schedule.id, { maxRuns: null, operationKey: "unlimited" }))
      .rejects.toThrow("AGENT_SCHEDULE_CONVERSATION_LIMIT_REQUIRED");
    await expect(agentScheduleRepository.update(auth, schedule.id, { maxRuns: 51, operationKey: "raise" }))
      .rejects.toThrow("AGENT_SCHEDULE_CONVERSATION_LIMIT_TOO_HIGH");
  });

  it("keeps the other kind of claim out while one holds the chat queue", async () => {
    await createWakeup();
    await queueDue();
    const holder = await database().connect();
    try {
      // A message claim in flight holds the queue row, so the wake-up claim passes it by.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM telegram_ingress_queues FOR UPDATE");
      expect(await conversationWakeupRepository.claimNext(LEASE)).toBeNull();
      await holder.query("ROLLBACK");

      // A wake-up claim in flight holds it too, and once committed its mark keeps the message out.
      await enqueueMessage("1001");
      const wakeupId = (await database().query<{ id: string }>("SELECT id::text FROM telegram_ingress_wakeups")).rows[0]!.id;
      await holder.query("BEGIN");
      await holder.query("UPDATE telegram_ingress_queues SET active_wakeup_id = $1", [wakeupId]);
      expect(await telegramIngressRepository.claimNext(LEASE, NO_BURSTS)).toBeNull();
      await holder.query("COMMIT");
      expect(await telegramIngressRepository.claimNext(LEASE, NO_BURSTS)).toBeNull();
    } finally {
      holder.release();
    }
  });

  it("parks a wake-up whose turn was refused before admission and ignores another turn", async () => {
    const schedule = await createWakeup();
    const job = await queueDue();
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", handoff());
    const turn = { applicationSessionId: sessionId, eveSessionId: "ses_eve_1", eveTurnId: "turn_4", runId: job.runId };

    // Deliveries of other turns in the same conversation must not make this run look delivered.
    expect(await conversationWakeupRunRepository.finishTurn({ ...turn, completedAt: new Date(), failureCode: "AGENT_TELEGRAM_PROCESSING_TIMEOUT" }))
      .toBe(true);
    const parked = await database().query("SELECT status, last_error_code FROM agent_schedules WHERE id = $1", [schedule.id]);
    expect(parked.rows[0]).toEqual({ last_error_code: "AGENT_CONVERSATION_WAKEUP_NOT_STARTED", status: "paused" });
    expect(await laneMark()).toBeNull();

    await agentScheduleRepository.update(auth, schedule.id, { enabled: true, operationKey: "resume" });
    await database().query("UPDATE agent_schedules SET next_run_at = now() - interval '1 second' WHERE id = $1", [schedule.id]);
    const again = await queueDue();
    const next = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(next!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(next!, "ses_eve_1", handoff());
    const own = { ...turn, eveTurnId: "turn_6", runId: again.runId };
    await conversationWakeupRunRepository.admitTurn(own);
    expect(await conversationWakeupRunRepository.finishTurn({ ...own, completedAt: new Date(), eveTurnId: "turn_8", failureCode: null }))
      .toBe(false);
    expect(await conversationWakeupRunRepository.finishTurn({ ...own, completedAt: new Date(), failureCode: null })).toBe(true);
  });

  it("sweeps a run whose item ended: unstarted past its deadline, or with a lost turn", async () => {
    const unstarted = await createWakeup();
    await queueDue();
    const first = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(first!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(first!, "ses_eve_1", handoff(new Date(Date.now() - 60_000)));
    await conversationWakeupRepository.fail(first!, { code: "AGENT_TELEGRAM_PROCESSING_TIMEOUT", message: "lost" });

    await agentScheduleDispatchRepository.claimDue({ leaseMilliseconds: LEASE, limit: 10, now: new Date() });
    const parked = await database().query("SELECT status, last_error_code FROM agent_schedules WHERE id = $1", [unstarted.id]);
    expect(parked.rows[0]).toEqual({ last_error_code: "AGENT_CONVERSATION_WAKEUP_NOT_STARTED", status: "paused" });

    // The failed item rotated the conversation; the next wake-up belongs to the next conversation.
    await database().query("UPDATE conversation_sessions SET rotation_requested_at = NULL WHERE id = $1", [sessionId]);
    const lost = await createWakeup();
    const job = await queueDue();
    const second = await conversationWakeupRepository.claimNext(LEASE);
    await conversationWakeupRepository.prepare(second!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(second!, "ses_eve_1", handoff());
    await conversationWakeupRunRepository.admitTurn({
      applicationSessionId: sessionId, eveSessionId: "ses_eve_1", eveTurnId: "turn_6", runId: job.runId,
    });
    await conversationWakeupRepository.fail(second!, { code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "lost" });
    await agentScheduleDispatchRepository.claimDue({ leaseMilliseconds: LEASE, limit: 10, now: new Date() });
    expect((await database().query("SELECT status FROM agent_schedule_runs WHERE id = $1", [job.runId])).rows[0].status)
      .toBe("running");

    await database().query("UPDATE telegram_ingress_wakeups SET completed_at = now() - interval '2 hours' WHERE run_id = $1", [job.runId]);
    await agentScheduleDispatchRepository.claimDue({ leaseMilliseconds: LEASE, limit: 10, now: new Date() });
    const run = await database().query("SELECT status, error_code FROM agent_schedule_runs WHERE id = $1", [job.runId]);
    expect(run.rows[0]).toEqual({ error_code: "AGENT_CONVERSATION_WAKEUP_TURN_LOST", status: "failed" });
    const schedule = await database().query("SELECT status, completed_runs FROM agent_schedules WHERE id = $1", [lost.id]);
    expect(schedule.rows[0]).toEqual({ completed_runs: 0, status: "active" });
  });

  it("lists the author's open and self-paused wake-ups for the turn's chat", async () => {
    const open = await createWakeup({ title: "Открытое" });
    const userPaused = await createWakeup({ title: "Пауза человека" });
    await agentScheduleRepository.update(auth, userPaused.id, { enabled: false, operationKey: "pause-user" });
    const selfPaused = await createWakeup({ title: "Сменился разговор" });
    await database().query(
      "UPDATE agent_schedules SET status = 'paused', last_error_code = $2 WHERE id = $1",
      [selfPaused.id, CONVERSATION_CHANGED_CODE],
    );
    const foreign = await createWakeup({ title: "Чужое" });
    const other = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('202', 'Другой') RETURNING id",
    )).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')", [familyId, other]);
    await database().query("UPDATE agent_schedules SET author_user_id = $2 WHERE id = $1", [foreign.id, other]);

    const planned = await conversationWakeupContextRepository.listPlanned("1000", familyId, auth.userId);
    expect(planned.map((wakeup) => wakeup.scheduleId)).toEqual([open.id, selfPaused.id]);

    // Pausing it by hand takes the self-paused one off the list the agent offers to resume.
    await agentScheduleRepository.update(auth, selfPaused.id, { enabled: false, operationKey: "pause-self" });
    const after = await conversationWakeupContextRepository.listPlanned("1000", familyId, auth.userId);
    expect(after.map((wakeup) => wakeup.scheduleId)).toEqual([open.id]);
  });

  it("is not blocked by a burst member once its stuck head was closed", async () => {
    await createWakeup();
    await enqueueMessage("1001", "первое");
    await enqueueMessage("1002", "второе");
    const head = await telegramIngressRepository.claimNext(LEASE, { ...NO_BURSTS, maxCharacters: 6_000, maxMessages: 2 });
    expect(head?.burstPayloads).toHaveLength(2);
    await telegramIngressRepository.fail(head!.updateId, head!.leaseToken, {
      code: "AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED", message: "Не удалось подтвердить остановку запроса",
    });
    // The owner closes the stuck head; its member keeps the copied code.
    await database().query("UPDATE telegram_ingress_updates SET last_error_code = 'AGENT_TELEGRAM_RECOVERY_CLOSED' WHERE update_id = 1001");
    await queueDue();

    expect(await conversationWakeupRepository.claimNext(LEASE)).not.toBeNull();
  });

  it("keeps a deploy waiting while a wake-up turn runs", async () => {
    await createWakeup();
    await queueDue();
    expect(await deployReadiness()).toBe("idle");
    const claim = await conversationWakeupRepository.claimNext(LEASE);
    expect(await deployReadiness()).toBe("busy");
    await conversationWakeupRepository.prepare(claim!, conversationCanonicalRouteToken);
    await conversationWakeupRepository.markDispatched(claim!, "ses_eve_1", handoff());
    await conversationWakeupRepository.complete(claim!, "ses_eve_1", 3);
    expect(await deployReadiness()).toBe("idle");
  });

  it("rebinds a wake-up to the current conversation when it is run now", async () => {
    const schedule = await createWakeup();
    await agentScheduleRepository.update(auth, schedule.id, { enabled: false, operationKey: "pause" });
    await database().query("UPDATE conversation_sessions SET retired_at = now() WHERE id = $1", [sessionId]);
    const next = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::", familyId, groupId: null, kind: "canonical", now: new Date(),
      scope: "personal", telegramForumTopicId: null, userId: auth.userId,
    });
    expect(next.id).not.toBe(sessionId);

    await agentScheduleRepository.runNow({ ...auth, applicationSessionId: next.id }, schedule.id, "run-now");
    const bound = await database().query("SELECT conversation_session_id::text FROM agent_schedules WHERE id = $1", [schedule.id]);
    expect(bound.rows[0].conversation_session_id).toBe(next.id);
  });
});
