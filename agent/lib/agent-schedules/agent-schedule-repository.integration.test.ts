/**
 * PostgreSQL scheduled agent scenario lifecycle integration tests.
 *
 * Constructs covered:
 * - Scoped CRUD and destination authorization.
 * - Group-only history configuration is rejected by the domain boundary before SQL mutation.
 * - Handoff-only leases, atomic delivered completion, recurrence, and ambiguous recovery.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { agentScheduleRepository } from "./agent-schedule-repository.js";
import { admitScheduledAgentTurn, recoverUnstartedAgentSchedules } from "./agent-schedule-recovery.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

interface Fixture {
  familyId: string;
  groupId: string;
  memberId: string;
  ownerId: string;
}

async function createFixture(): Promise<Fixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Agent schedules') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('schedule-owner', 'Владелец'), ('schedule-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "schedule-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "schedule-member")!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, ownerId, memberId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-agent-schedules', 'Семья', 'family_private', 'addressed_only')
     RETURNING id`,
    [family.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, groupId: group.rows[0]!.id, memberId, ownerId };
}

function privateAuth(fixture: Fixture, user: "member" | "owner") {
  const owner = user === "owner";
  return {
    familyId: fixture.familyId,
    forumTopicId: null,
    groupId: null,
    groupType: null,
    messageThreadId: null,
    role: owner ? "owner" as const : "member" as const,
    telegramChatId: owner ? "schedule-owner" : "schedule-member",
    telegramChatType: "private" as const,
    telegramUserId: owner ? "schedule-owner" : "schedule-member",
    userId: owner ? fixture.ownerId : fixture.memberId,
  };
}

function familyAuth(fixture: Fixture, user: "member" | "owner") {
  const base = privateAuth(fixture, user);
  return {
    ...base,
    groupId: fixture.groupId,
    forumTopicId: "88",
    groupType: "family_private" as const,
    messageThreadId: "88",
    telegramChatId: "-100-agent-schedules",
    telegramChatType: "supergroup" as const,
  };
}

describeWithDatabase("agent schedule repositories", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, agent_schedule_operations, agent_schedule_runs, agent_schedules,
       conversation_session_routes, conversation_sessions, telegram_groups,
       family_memberships, users, families CASCADE`,
    );
  });
  afterAll(async () => closeDatabase());

  it("recovers a pre-model handoff of the same occurrence and fences the late old run", async () => {
    const fixture = await createFixture();
    const now = new Date();
    const schedule = await agentScheduleRepository.create(privateAuth(fixture, "owner"), {
      firstRunAt: new Date(now.getTime()-1000), operationKey: "recover-handoff", recurrence: { kind: "once" },
      scenarioPrompt: "Проверь новости", scope: "personal", timezone: "Europe/Moscow", title: "Проверка", userRequest: "Проверь новости",
    });
    const job = (await agentScheduleDispatchRepository.claimDue({ now, limit: 10, leaseMilliseconds: 60000 }))[0]!;
    const session = await sessionRepository.prepareTurn({ baseContinuationToken: `schedule:${job.runId}`,
      familyId: fixture.familyId, groupId: null, kind: "scheduled", now, scope: "personal", telegramForumTopicId: null, userId: fixture.ownerId });
    await agentScheduleDispatchRepository.markDispatchStarted(job, { applicationSessionId: session.id });
    await database().query("UPDATE agent_schedules SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [schedule.id]);
    const client = await database().connect();
    try { await client.query("BEGIN"); await recoverUnstartedAgentSchedules(client, now); await client.query("COMMIT"); }
    finally { client.release(); }
    await expect(admitScheduledAgentTurn({ runId: job.runId, applicationSessionId: session.id, eveSessionId: "late", eveTurnId: "turn_0" }))
      .rejects.toThrow("AGENT_SCHEDULE_ATTEMPT_STALE");
    const next = (await agentScheduleDispatchRepository.claimDue({ now: new Date(), limit: 10, leaseMilliseconds: 60000 }))[0]!;
    expect(next.id).toBe(schedule.id);
    expect(next.runId).toBe(job.runId);
    expect(next.nextRunAt).toBe(job.nextRunAt);
  });

  it("creates and lists a personal scheduled agent scenario", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");

    const schedule = await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T06:00:00.000Z"),
      operationKey: "create-personal-news",
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], interval: 1, kind: "weekly" },
      scenarioPrompt: "Собрать сводку новостей по ИИ и прислать 5 пунктов.",
      scope: "personal",
      timezone: "Europe/Moscow",
      title: "Новости ИИ",
      userRequest: "Каждый будний день присылай новости по ИИ",
    });

    expect(schedule).toMatchObject({
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], interval: 1, kind: "weekly" },
      scope: "personal",
      status: "active",
      title: "Новости ИИ",
    });
    await expect(agentScheduleRepository.list(auth, { limit: 100 })).resolves.toEqual({
      items: [schedule],
      nextCursor: null,
    });
    await expect(agentScheduleRepository.findById(auth, schedule.id)).resolves.toEqual(schedule);
    await expect(
      agentScheduleRepository.findById(privateAuth(fixture, "owner"), schedule.id),
    ).resolves.toBeNull();
  });

  it("requires a verified family group destination for family schedules", async () => {
    const fixture = await createFixture();

    await expect(agentScheduleRepository.create(privateAuth(fixture, "owner"), {
      firstRunAt: new Date("2026-07-17T06:00:00.000Z"),
      operationKey: "bad-family-destination",
      recurrence: { interval: 1, kind: "daily" },
      scenarioPrompt: "Собрать семейную сводку.",
      scope: "family",
      timezone: "Europe/Moscow",
      title: "Семейная сводка",
      userRequest: "Присылай семье сводку",
    })).rejects.toThrowError(/AGENT_SCHEDULE_DESTINATION_INVALID/);

    await expect(agentScheduleRepository.create(familyAuth(fixture, "owner"), {
      firstRunAt: new Date("2026-07-17T06:00:00.000Z"),
      operationKey: "good-family-destination",
      recurrence: { interval: 1, kind: "daily" },
      scenarioPrompt: "Собрать семейную сводку.",
      scope: "family",
      timezone: "Europe/Moscow",
      title: "Семейная сводка",
      userRequest: "Присылай семье сводку",
    })).resolves.toMatchObject({ scope: "family" });
  });

  it("rejects history configuration for a non-group schedule before SQL mutation", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    const schedule = await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T06:00:00.000Z"),
      operationKey: "create-personal-without-history",
      recurrence: { interval: 1, kind: "daily" },
      scenarioPrompt: "Собрать личную сводку.",
      scope: "personal",
      timezone: "Europe/Moscow",
      title: "Личная сводка",
      userRequest: "Присылай личную сводку",
    });

    await expect(agentScheduleRepository.update(auth, schedule.id, {
      historyWindowDays: 7,
      operationKey: "invalid-personal-history",
    })).rejects.toMatchObject({
      code: "AGENT_EXTERNAL_SCHEDULE_HISTORY_WINDOW_INVALID",
    });
    const persisted = await database().query<{ history_window_days: number | null }>(
      "SELECT history_window_days FROM agent_schedules WHERE id = $1",
      [schedule.id],
    );
    expect(persisted.rows[0]?.history_window_days).toBeNull();
  });

  it("claims a weekday schedule once and advances it after Eve completion", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "weekday-created",
      recurrence: { daysOfWeek: [1, 2, 3, 4, 5], interval: 1, kind: "weekly" },
      scenarioPrompt: "Сделать будничную сводку.",
      scope: "personal",
      timezone: "UTC",
      title: "Будничная сводка",
      userRequest: "Каждый будний день присылай сводку",
    });

    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-17T09:00:01.000Z"),
    });
    expect(claimed).toMatchObject({ telegramChatId: "schedule-member", title: "Будничная сводка" });
    await expect(agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 300_000,
      limit: 10,
      now: new Date("2026-07-17T09:00:02.000Z"),
    })).resolves.toEqual([]);

    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: "schedule-member::schedule:test-run",
      kind: "scheduled",
      telegramForumTopicId: null,
      familyId: fixture.familyId,
      groupId: null,
      now: new Date("2026-07-17T09:00:01.000Z"),
      scope: "personal",
      userId: fixture.memberId,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(claimed!, {
      applicationSessionId: prepared.id,
    });
    await agentScheduleDispatchRepository.markRunning(claimed!, {
      applicationSessionId: prepared.id,
      eveSessionId: "eve-schedule-1",
    });
    const delivery = {
      applicationSessionId: prepared.id,
      content: "Будничная сводка готова",
      deliveredAt: new Date("2026-07-17T09:01:00.000Z"),
      eveSessionId: "eve-schedule-1",
      familyId: fixture.familyId,
      groupId: null,
      messageThreadId: null,
      ownerUserId: fixture.memberId,
      runId: claimed!.runId,
      scheduledFor: new Date(claimed!.nextRunAt),
      scope: "personal",
      telegramChatId: claimed!.telegramChatId,
      telegramMessageId: "501",
      title: claimed!.title,
    } as const;

    // An unknown run cannot create an orphan receipt or finalize another schedule.
    await expect(agentScheduleDispatchRepository.completeDeliveredRun({
      ...delivery,
      runId: "00000000-0000-4000-8000-000000000999",
    })).rejects.toMatchObject({ code: "AGENT_SCHEDULE_DELIVERY_STATE_INVALID" });
    await expect(database().query("SELECT 1 FROM proactive_deliveries")).resolves.toMatchObject({
      rowCount: 0,
    });

    // Once Telegram delivery belongs to a durable run, retain the receipt despite identity conflict.
    await expect(agentScheduleDispatchRepository.completeDeliveredRun({
      ...delivery,
      eveSessionId: "eve-schedule-conflict",
    })).rejects.toMatchObject({ code: "AGENT_SCHEDULE_DELIVERY_STATE_INVALID" });
    await expect(database().query("SELECT 1 FROM proactive_deliveries")).resolves.toMatchObject({
      rowCount: 1,
    });

    await expect(agentScheduleDispatchRepository.completeDeliveredRun(delivery)).resolves.toBe(true);
    await expect(agentScheduleDispatchRepository.completeDeliveredRun(delivery)).resolves.toBe(false);

    await expect(agentScheduleRepository.list(auth, { limit: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ nextRunAt: "2026-07-20T09:00:00.000Z", status: "active" })],
      nextCursor: null,
    });
    await expect(database().query(
      "SELECT source_id::text, telegram_message_id::text FROM proactive_deliveries",
    )).resolves.toMatchObject({
      rows: [{ source_id: claimed!.runId, telegram_message_id: "501" }],
    });
  });

  it("reclaims an expired pre-handoff lease without duplicating the scheduled occurrence", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "recoverable-created",
      recurrence: { kind: "once" },
      scenarioPrompt: "Запустить после безопасного восстановления lease.",
      scope: "personal",
      timezone: "UTC",
      title: "Восстановимый запуск",
      userRequest: "Запусти один раз",
    });

    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:00.000Z"),
    });
    const [reclaimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:02.000Z"),
    });

    expect(reclaimed).toMatchObject({ runId: claimed!.runId, title: "Восстановимый запуск" });
    expect(reclaimed!.leaseToken).not.toBe(claimed!.leaseToken);

    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: "schedule-member::schedule:recoverable-run",
      kind: "scheduled",
      telegramForumTopicId: null,
      familyId: fixture.familyId,
      groupId: null,
      now: new Date("2026-07-17T09:00:02.000Z"),
      scope: "personal",
      userId: fixture.memberId,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(reclaimed!, {
      applicationSessionId: prepared.id,
    });
    await agentScheduleDispatchRepository.markRunning(reclaimed!, {
      applicationSessionId: prepared.id,
      eveSessionId: "eve-schedule-recovered",
    });
    await agentScheduleDispatchRepository.completeDeliveredRun({
      applicationSessionId: prepared.id,
      content: "Одноразовый результат",
      deliveredAt: new Date("2026-07-17T09:01:00.000Z"),
      eveSessionId: "eve-schedule-recovered",
      familyId: fixture.familyId,
      groupId: null,
      messageThreadId: null,
      ownerUserId: fixture.memberId,
      runId: reclaimed!.runId,
      scheduledFor: new Date(reclaimed!.nextRunAt),
      scope: "personal",
      telegramChatId: reclaimed!.telegramChatId,
      telegramMessageId: "502",
      title: reclaimed!.title,
    });

    await expect(agentScheduleRepository.list(auth, { limit: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({ status: "completed" })],
      nextCursor: null,
    });
  });

  it("does not expire a running scenario with its short handoff lease", async () => {
    const fixture = await createFixture();
    await agentScheduleRepository.create(privateAuth(fixture, "member"), {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "long-running-created",
      recurrence: { kind: "once" },
      scenarioPrompt: "Подготовить подробную сводку.",
      scope: "personal",
      timezone: "UTC",
      title: "Долгий запуск",
      userRequest: "Подготовь подробную сводку",
    });
    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:00.000Z"),
    });
    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: "schedule-member::schedule:long-running",
      kind: "scheduled",
      telegramForumTopicId: null,
      familyId: fixture.familyId,
      groupId: null,
      now: new Date("2026-07-17T09:00:00.000Z"),
      scope: "personal",
      userId: fixture.memberId,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(claimed!, {
      applicationSessionId: prepared.id,
    });

    await agentScheduleDispatchRepository.markRunning(claimed!, {
      applicationSessionId: prepared.id,
      eveSessionId: "eve-schedule-long-running",
    });
    await admitScheduledAgentTurn({ runId: claimed!.runId, applicationSessionId: prepared.id,
      eveSessionId: "eve-schedule-long-running", eveTurnId: "turn_0" });

    await expect(agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:02.000Z"),
    })).resolves.toEqual([]);
    await expect(agentScheduleRepository.list(
      privateAuth(fixture, "member"),
      { limit: 100 },
    )).resolves.toMatchObject({
      items: [expect.objectContaining({ lastErrorCode: null, status: "leased" })],
      nextCursor: null,
    });
  });

  it("does not retry a legacy expired lease after Eve handoff may have started", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    await agentScheduleRepository.create(auth, {
      firstRunAt: new Date("2026-07-17T09:00:00.000Z"),
      operationKey: "ambiguous-created",
      recurrence: { kind: "once" },
      scenarioPrompt: "Не продублировать запуск.",
      scope: "personal",
      timezone: "UTC",
      title: "Одноразовый запуск",
      userRequest: "Запусти один раз",
    });
    const [claimed] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:00.000Z"),
    });
    const prepared = await sessionRepository.prepareTurn({
      baseContinuationToken: "schedule-member::schedule:ambiguous",
      familyId: fixture.familyId,
      groupId: null,
      kind: "scheduled",
      now: new Date("2026-07-17T09:00:00.000Z"),
      scope: "personal",
      telegramForumTopicId: null,
      userId: fixture.memberId,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(claimed!, {
      applicationSessionId: prepared.id,
    });
    await database().query("UPDATE agent_schedule_runs SET recovery_protocol=0 WHERE id=$1", [claimed!.runId]);

    await expect(agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 1_000,
      limit: 1,
      now: new Date("2026-07-17T09:00:02.000Z"),
    })).resolves.toEqual([]);
    await expect(agentScheduleRepository.list(auth, { limit: 100 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({ lastErrorCode: "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", status: "failed" }),
      ],
      nextCursor: null,
    });
    const run = await database().query<{ error_code: string | null; status: string }>(
      "SELECT status, error_code FROM agent_schedule_runs WHERE schedule_id = $1",
      [claimed!.id],
    );
    expect(run.rows).toEqual([
      { error_code: "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", status: "ambiguous" },
    ]);
  });

  it("paginates more than 100 active schedules without duplicates or skipped timestamp ties", async () => {
    const fixture = await createFixture();
    const auth = privateAuth(fixture, "member");
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO agent_schedules
         (family_id, owner_user_id, author_user_id, scope, title, user_request, scenario_prompt,
          timezone, recurrence_kind, recurrence_interval, recurrence_anchor_local, next_run_at,
          telegram_chat_id, telegram_chat_type, created_at)
       SELECT $1, $2, $2, 'personal', 'Расписание ' || item, 'Запрос', 'Сценарий', 'UTC',
              'daily', 1, timestamp '2026-01-01 00:00:00',
              timestamptz '2026-01-01 00:00:00+00', 'schedule-member', 'private',
              timestamptz '2026-02-01 00:00:00+00'
         FROM generate_series(1, 102) AS item
       RETURNING id`,
      [fixture.familyId, fixture.memberId],
    );

    const first = await agentScheduleRepository.list(auth, { limit: 100 });
    const second = await agentScheduleRepository.list(auth, {
      cursor: first.nextCursor!,
      limit: 100,
    });
    const ids = [...first.items, ...second.items].map((item) => item.id);

    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
    expect(ids).toHaveLength(102);
    expect(new Set(ids)).toHaveLength(102);
    expect(new Set(ids)).toEqual(new Set(inserted.rows.map((row) => row.id)));
    await expect(agentScheduleRepository.list(auth, { cursor: "invalid", limit: 100 }))
      .rejects.toMatchObject({ code: "AGENT_SCHEDULE_CURSOR_INVALID" });
  });
});
