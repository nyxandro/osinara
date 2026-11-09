/**
 * PostgreSQL integration tests of a scenario read for the day by its button (#480).
 *
 * Constructs covered:
 * - A press on the person's own scenario skips it until the next midnight of its timezone, once:
 *   a replay writes the same value and no second audit event.
 * - Due occurrences before the skip pass to the first occurrence at or after it without a run, and
 *   the dispatcher claims nothing; the list shows the skip.
 * - A card of an earlier day, a scenario of another chat or of another person counts nothing.
 * - Only scenarios of the button's own chat and person are valid targets.
 * - The skip only moves forward: an older card pressed again never brings back skipped runs.
 * - A press already applied still counts after the scenario ended.
 * - An explicit new time or "run it now" clears the skip, so it never swallows that run.
 * - A family scenario is skipped only by its author or the family's owner.
 * - A one-off scenario whose only run falls into the skip ends without running.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import type { AgentScheduleAuthorization } from "./agent-schedule-context.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";
import { findAgentScheduleSkipTargets, skipAgentScheduleForDay } from "./agent-schedule-skip.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;
if (integrationTestsEnabled && (!integrationDatabaseUrl || !new URL(integrationDatabaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const minutes = (count: number) => new Date(Date.now() + count * 60_000);
const TIMEZONE = "Europe/Moscow";

describeWithDatabase("scenario read for the day (#480)", () => {
  let auth: AgentScheduleAuthorization;

  async function createHourly() {
    return await agentScheduleRepository.create(auth, {
      executionContext: "isolated",
      firstRunAt: minutes(30),
      operationKey: `create-${Math.random()}`,
      recurrence: { interval: 1, kind: "hourly" },
      scenarioPrompt: "Если задачи не подтверждены, повтори их голосом и карточкой",
      scope: "personal",
      timezone: TIMEZONE,
      title: "Контроль задач",
      userRequest: "Повторяй задачи каждый час, пока не подтвержу",
    });
  }

  async function nextMidnight(at: Date): Promise<Date> {
    const result = await database().query<{ until: Date }>(
      "SELECT ((($1::timestamptz AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2) AS until",
      [at, TIMEZONE],
    );
    return result.rows[0]!.until;
  }

  beforeEach(async () => {
    await database().query(
      `TRUNCATE agent_schedule_runs, agent_schedule_operations, agent_schedules, audit_events,
         conversation_session_routes, conversation_sessions, conversation_route_generations,
         application_conversations, telegram_groups, family_memberships, users, families CASCADE`,
    );
    const familyId = (await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Задачи') RETURNING id")).rows[0]!.id;
    const userId = (await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('101', 'Гость') RETURNING id",
    )).rows[0]!.id;
    await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, userId]);
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "101::", familyId, groupId: null, kind: "canonical", now: new Date(),
      scope: "personal", telegramForumTopicId: null, userId,
    });
    auth = {
      applicationSessionId: session.id, familyId, forumTopicId: null, groupId: null, groupType: null,
      messageThreadId: null, role: "owner", telegramChatId: "101", telegramChatType: "private",
      telegramUpdateId: "1000", telegramUserId: "101", userId,
    };
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("skips the person's own scenario until the next midnight of its timezone, once", async () => {
    const schedule = await createHourly();
    const pressedAt = new Date();

    const first = await skipAgentScheduleForDay({
      addresseeTelegramUserId: "101", pressedAt, pressId: "press-1", scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
    });
    const replay = await skipAgentScheduleForDay({
      addresseeTelegramUserId: "101", pressedAt, pressId: "press-1", scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
    });

    expect(first).toMatchObject({ kind: "skipped", title: "Контроль задач" });
    expect(replay).toEqual(first);
    const stored = (await database().query<{ skipped_at: Date; skipped_until: Date }>(
      "SELECT skipped_until, skipped_at FROM agent_schedules WHERE id = $1", [schedule.id],
    )).rows[0]!;
    expect(stored.skipped_until.toISOString()).toBe((await nextMidnight(pressedAt)).toISOString());
    expect(stored.skipped_at.toISOString()).toBe(pressedAt.toISOString());
    const audits = await database().query("SELECT 1 FROM audit_events WHERE event_type = 'agent_schedule.skipped_for_day'");
    expect(audits.rowCount).toBe(1);
  });

  it("passes the day's due occurrences without a run and shows the skip in the list", async () => {
    const schedule = await createHourly();
    const pressedAt = new Date();
    await skipAgentScheduleForDay({
      pressId: "press-auto-1", addresseeTelegramUserId: "101", pressedAt, scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
    });
    await database().query("UPDATE agent_schedules SET next_run_at = $2 WHERE id = $1", [schedule.id, minutes(-1)]);

    const claimed = await agentScheduleDispatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 10, now: new Date() });

    expect(claimed).toEqual([]);
    const state = (await database().query<{ next_run_at: Date; runs: number; status: string }>(
      `SELECT status::text, next_run_at, (SELECT count(*)::int FROM agent_schedule_runs WHERE schedule_id = $1) AS runs
         FROM agent_schedules WHERE id = $1`,
      [schedule.id],
    )).rows[0]!;
    const midnight = await nextMidnight(pressedAt);
    expect(state.status).toBe("active");
    expect(state.runs).toBe(0);
    expect(state.next_run_at.getTime()).toBeGreaterThanOrEqual(midnight.getTime());
    expect(state.next_run_at.getTime()).toBeLessThan(midnight.getTime() + 60 * 60_000);
    const listed = await agentScheduleRepository.list(auth, { limit: 10 });
    expect(listed.items[0]).toMatchObject({ skip: { pressedAt: pressedAt.toISOString(), until: midnight.toISOString() } });
  });

  it("counts nothing for a card of an earlier day, another chat or another person", async () => {
    const schedule = await createHourly();
    const pressedAt = new Date();
    const yesterday = new Date(pressedAt.getTime() - 26 * 60 * 60_000);

    await expect(skipAgentScheduleForDay({
      pressId: "press-auto-2", addresseeTelegramUserId: "101", pressedAt, scheduleId: schedule.id, sentAt: yesterday, telegramChatId: "101",
    })).resolves.toEqual({ kind: "stale" });
    await expect(skipAgentScheduleForDay({
      pressId: "press-auto-3", addresseeTelegramUserId: "202", pressedAt, scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
    })).resolves.toEqual({ kind: "missing" });
    await expect(skipAgentScheduleForDay({
      pressId: "press-auto-4", addresseeTelegramUserId: "101", pressedAt, scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "999",
    })).resolves.toEqual({ kind: "missing" });
    const stored = await database().query("SELECT 1 FROM agent_schedules WHERE id = $1 AND skipped_until IS NULL", [schedule.id]);
    expect(stored.rowCount).toBe(1);
  });

  it("accepts only scenarios of the button's own chat and person as targets", async () => {
    const schedule = await createHourly();
    const unknown = "00000000-0000-4000-8000-000000000000";

    expect(await findAgentScheduleSkipTargets({ addresseeTelegramUserId: "101", scheduleIds: [schedule.id, unknown], telegramChatId: "101" }))
      .toEqual(new Set([schedule.id]));
    expect(await findAgentScheduleSkipTargets({ addresseeTelegramUserId: "202", scheduleIds: [schedule.id], telegramChatId: "101" }))
      .toEqual(new Set());
  });

  it("only moves forward: an older card pressed again never brings back skipped runs", async () => {
    const schedule = await createHourly();
    const today = new Date();
    const yesterday = new Date(today.getTime() - 26 * 60 * 60_000);
    await skipAgentScheduleForDay({
      pressId: "press-auto-5", addresseeTelegramUserId: "101", pressedAt: today, scheduleId: schedule.id, sentAt: today, telegramChatId: "101",
    });

    // Yesterday's card, pressed yesterday and settled again today after its edit was lost.
    await expect(skipAgentScheduleForDay({
      pressId: "press-auto-6", addresseeTelegramUserId: "101", pressedAt: yesterday, scheduleId: schedule.id, sentAt: yesterday, telegramChatId: "101",
    })).resolves.toMatchObject({ kind: "skipped" });

    const stored = (await database().query<{ skipped_until: Date }>("SELECT skipped_until FROM agent_schedules WHERE id = $1", [schedule.id])).rows[0]!;
    expect(stored.skipped_until.toISOString()).toBe((await nextMidnight(today)).toISOString());
  });

  it("still counts a press already applied after the scenario ended", async () => {
    const schedule = await createHourly();
    const pressedAt = new Date();
    const first = await skipAgentScheduleForDay({
      pressId: "press-auto-7", addresseeTelegramUserId: "101", pressedAt, scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
    });
    await database().query("UPDATE agent_schedules SET status = 'completed' WHERE id = $1", [schedule.id]);

    await expect(skipAgentScheduleForDay({
      pressId: "press-auto-7", addresseeTelegramUserId: "101", pressedAt, scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
    })).resolves.toEqual(first);
  });

  it("clears the skip for an explicit new time or a run now", async () => {
    for (const change of ["update", "runNow"] as const) {
      const schedule = await createHourly();
      const pressedAt = new Date();
      const press = () => skipAgentScheduleForDay({
        pressId: `press-${change}`, addresseeTelegramUserId: "101", pressedAt, scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
      });
      await press();

      if (change === "update") {
        await agentScheduleRepository.update(auth, schedule.id, { nextRunAt: minutes(5), operationKey: `move-${schedule.id}` });
      } else {
        await agentScheduleRepository.runNow(auth, schedule.id, `run-${schedule.id}`);
      }
      // The same press replayed afterwards (the queue step, a lost edit) must not swallow that run.
      await expect(press()).resolves.toMatchObject({ kind: "skipped" });

      const stored = (await database().query("SELECT skipped_until, skipped_at FROM agent_schedules WHERE id = $1", [schedule.id])).rows[0];
      expect(stored, change).toEqual({ skipped_at: null, skipped_until: null });
    }
  });

  it("lets only a family scenario's author or the family's owner skip it", async () => {
    const familyId = auth.familyId;
    const users = await database().query<{ id: string; telegram_user_id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('202', 'Автор'), ('303', 'Другой') RETURNING id, telegram_user_id",
    );
    const authorId = users.rows.find((row) => row.telegram_user_id === "202")!.id;
    const otherId = users.rows.find((row) => row.telegram_user_id === "303")!.id;
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')",
      [familyId, authorId, otherId],
    );
    const groupId = (await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-family', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
      [familyId],
    )).rows[0]!.id;
    const schedule = await agentScheduleRepository.create({
      ...auth, groupId, groupType: "family_private", role: "member", telegramChatId: "-100-family",
      telegramChatType: "supergroup", telegramUserId: "202", userId: authorId,
    }, {
      executionContext: "isolated", firstRunAt: minutes(30), operationKey: "family-create",
      recurrence: { interval: 1, kind: "hourly" }, scenarioPrompt: "Напомни семье о делах", scope: "family",
      timezone: TIMEZONE, title: "Семейные дела", userRequest: "Напоминай семье каждый час",
    });
    const press = (addressee: string) => skipAgentScheduleForDay({
      pressId: "press-auto-10", addresseeTelegramUserId: addressee, pressedAt: new Date(), scheduleId: schedule.id, sentAt: new Date(), telegramChatId: "-100-family",
    });

    await expect(press("303")).resolves.toEqual({ kind: "missing" });
    await expect(press("202")).resolves.toMatchObject({ kind: "skipped" });
    await expect(press("101")).resolves.toMatchObject({ kind: "skipped" });
  });

  it("ends a one-off scenario whose only run falls into the skip", async () => {
    const schedule = await agentScheduleRepository.create(auth, {
      executionContext: "isolated", firstRunAt: minutes(30), operationKey: "once-create",
      recurrence: { kind: "once" }, scenarioPrompt: "Напомни один раз", scope: "personal",
      timezone: TIMEZONE, title: "Один раз", userRequest: "Напомни один раз",
    });
    const pressedAt = new Date();
    await skipAgentScheduleForDay({
      pressId: "press-auto-11", addresseeTelegramUserId: "101", pressedAt, scheduleId: schedule.id, sentAt: pressedAt, telegramChatId: "101",
    });
    await database().query("UPDATE agent_schedules SET next_run_at = $2 WHERE id = $1", [schedule.id, minutes(-1)]);

    await agentScheduleDispatchRepository.claimDue({ leaseMilliseconds: 60_000, limit: 10, now: new Date() });

    const state = (await database().query("SELECT status::text, (SELECT count(*)::int FROM agent_schedule_runs WHERE schedule_id = $1) AS runs FROM agent_schedules WHERE id = $1", [schedule.id])).rows[0];
    expect(state).toEqual({ runs: 0, status: "completed" });
  });
});
