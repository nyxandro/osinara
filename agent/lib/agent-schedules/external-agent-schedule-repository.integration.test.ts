/**
 * External-group scheduled automation PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Only the current owner can create and list external-group schedules from private administration.
 * - Destination identity/type and schedule capability subset come from the registered group row.
 * - History and capability configuration updates stay bound to `scope=group`.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "../sessions/session-repository.js";
import { authorizeAgentScheduleExecution } from "./agent-schedule-delivery-authorization.js";
import { agentScheduleDispatchRepository } from "./agent-schedule-dispatch-repository.js";
import { externalAgentScheduleRepository } from "./external-agent-schedule-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('External schedules') RETURNING id",
  );
  const users = await database().query<{ id: string; telegram_user_id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('external-schedule-owner', 'Владелец'), ('external-schedule-member', 'Участник')
     RETURNING id, telegram_user_id`,
  );
  const ownerId = users.rows.find((row) => row.telegram_user_id === "external-schedule-owner")!.id;
  const memberId = users.rows.find((row) => row.telegram_user_id === "external-schedule-member")!.id;
  await database().query(
    `INSERT INTO family_memberships (family_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [family.rows[0]!.id, ownerId, memberId],
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, telegram_chat_type, title, type, message_mode, tool_allowlist)
     VALUES ($1, '-100-external-schedule', 'supergroup', 'Публичный чат', 'external', 'all',
             ARRAY['send_workspace_file', 'web_fetch'])
     RETURNING id`,
    [family.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, groupId: group.rows[0]!.id, memberId, ownerId };
}

describeWithDatabase("external agent schedule repository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE proactive_deliveries, agent_schedule_operations, agent_schedule_runs,
       agent_schedules, conversation_session_routes, conversation_sessions, telegram_groups,
       family_memberships, users, families CASCADE`,
    );
  });
  afterAll(async () => closeDatabase());

  it.each(["minutely", "hourly", "monthly", "yearly"] as const)("creates and updates %s automation without losing its identity", async (kind) => {
    const setup = await fixture();
    const auth = { familyId: setup.familyId, requestedBy: setup.ownerId };
    const recurrence = { kind, interval: 1 };
    const created = await externalAgentScheduleRepository.create(auth, {
      capabilityAllowlist: [], firstRunAt: new Date("2026-10-25T02:30:00+02:00"), operationKey: "new-period",
      recurrence, scenarioPrompt: "Проверь ресурс", telegramChatId: "-100-external-schedule",
      timezone: "Europe/Berlin", title: "Проверка", userRequest: "Проверяй по расписанию",
    });
    expect(created).toMatchObject({ recurrence, scope: "group" });
    const anchor = await database().query("SELECT recurrence_anchor_at FROM agent_schedules WHERE id = $1", [created.id]);
    expect(anchor.rows[0].recurrence_anchor_at).toEqual(new Date("2026-10-25T00:30:00Z"));
    const updated = await externalAgentScheduleRepository.update(auth, created.id, {
      recurrence: { kind, interval: 2 }, operationKey: "new-period-update",
    });
    expect(updated).toMatchObject({ id: created.id, recurrence: { kind, interval: 2 }, scope: "group" });
  });

  it("creates an owner-approved group schedule from the registered destination", async () => {
    const setup = await fixture();
    const authorization = { familyId: setup.familyId, requestedBy: setup.ownerId };

    const created = await externalAgentScheduleRepository.create(authorization, {
      capabilityAllowlist: ["send_workspace_file"],
      firstRunAt: new Date("2026-08-17T06:00:00.000Z"),
      historyWindowDays: 7,
      operationKey: "create-external-weekly-summary",
      recurrence: { daysOfWeek: [1], interval: 1, kind: "weekly" },
      scenarioPrompt: "Прочитай snapshot, создай HTML-выжимку и отправь файл.",
      telegramChatId: "-100-external-schedule",
      timezone: "Europe/Moscow",
      title: "Недельная выжимка",
      userRequest: "Каждый понедельник присылай выжимку обсуждения за неделю",
    });

    expect(created).toMatchObject({
      capabilityAllowlist: ["send_workspace_file"],
      historyWindowDays: 7,
      scope: "group",
      telegramChatId: "-100-external-schedule",
      telegramGroupTitle: "Публичный чат",
    });
    await expect(externalAgentScheduleRepository.list({
      ...authorization,
      telegramChatId: null,
    })).resolves.toMatchObject({ total: 1 });
    const persisted = await database().query<{
      group_id: string;
      telegram_chat_type: string;
    }>(
      "SELECT group_id, telegram_chat_type FROM agent_schedules WHERE id = $1",
      [created.id],
    );
    expect(persisted.rows[0]).toEqual({ group_id: setup.groupId, telegram_chat_type: "supergroup" });
    await expect(externalAgentScheduleRepository.create(authorization, {
      capabilityAllowlist: ["send_workspace_file"],
      firstRunAt: new Date("2026-08-17T06:00:00.000Z"),
      historyWindowDays: 7,
      operationKey: "create-external-weekly-summary",
      recurrence: { daysOfWeek: [1], interval: 1, kind: "weekly" },
      scenarioPrompt: "Прочитай snapshot, создай HTML-выжимку и отправь файл.",
      telegramChatId: "-100-external-schedule",
      timezone: "Europe/Moscow",
      title: "Другой заголовок",
      userRequest: "Каждый понедельник присылай выжимку обсуждения за неделю",
    })).rejects.toMatchObject({ code: "AGENT_SCHEDULE_OPERATION_CONFLICT" });
  });

  it("rejects a non-owner and a capability absent from the current group policy", async () => {
    const setup = await fixture();
    const input = {
      capabilityAllowlist: ["send_workspace_file"] as const,
      firstRunAt: new Date("2026-08-17T06:00:00.000Z"),
      operationKey: "denied-create",
      recurrence: { interval: 1, kind: "daily" as const },
      scenarioPrompt: "Подготовь отчёт.",
      telegramChatId: "-100-external-schedule",
      timezone: "Europe/Moscow",
      title: "Отчёт",
      userRequest: "Присылай отчёт",
    };

    await expect(externalAgentScheduleRepository.create(
      { familyId: setup.familyId, requestedBy: setup.memberId },
      { ...input, capabilityAllowlist: [...input.capabilityAllowlist] },
    )).rejects.toMatchObject({ code: "AGENT_OWNER_REQUIRED" });
    await expect(externalAgentScheduleRepository.create(
      { familyId: setup.familyId, requestedBy: setup.ownerId },
      { ...input, capabilityAllowlist: ["search_memories"], operationKey: "ungranted-create" },
    )).rejects.toMatchObject({ code: "AGENT_EXTERNAL_SCHEDULE_CAPABILITY_NOT_GRANTED" });
  });

  it("updates lifecycle state without changing the registered destination", async () => {
    const setup = await fixture();
    const authorization = { familyId: setup.familyId, requestedBy: setup.ownerId };
    const created = await externalAgentScheduleRepository.create(authorization, {
      capabilityAllowlist: ["send_workspace_file"],
      firstRunAt: new Date("2026-08-17T06:00:00.000Z"),
      historyWindowDays: 7,
      operationKey: "create-external-lifecycle",
      recurrence: { daysOfWeek: [1], interval: 1, kind: "weekly" },
      scenarioPrompt: "Подготовь HTML-отчёт.",
      telegramChatId: "-100-external-schedule",
      timezone: "Europe/Moscow",
      title: "Исходный отчёт",
      userRequest: "Присылай отчёт",
    });

    await expect(externalAgentScheduleRepository.update(authorization, created.id, {
      capabilityAllowlist: ["web_fetch"],
      historyWindowDays: null,
      operationKey: "update-external-lifecycle",
      title: "Обновлённый отчёт",
    })).resolves.toMatchObject({
      capabilityAllowlist: ["web_fetch"],
      historyWindowDays: null,
      telegramChatId: "-100-external-schedule",
      title: "Обновлённый отчёт",
    });
    await expect(externalAgentScheduleRepository.setEnabled(
      authorization,
      created.id,
      false,
      "pause-external-lifecycle",
    )).resolves.toMatchObject({ status: "paused" });
    await expect(externalAgentScheduleRepository.setEnabled(
      authorization,
      created.id,
      true,
      "resume-external-lifecycle",
    )).resolves.toMatchObject({ status: "active" });
    await expect(externalAgentScheduleRepository.runNow(
      authorization,
      created.id,
      "run-external-lifecycle",
    )).resolves.toMatchObject({ status: "active", telegramChatId: "-100-external-schedule" });
    await expect(externalAgentScheduleRepository.delete(
      authorization,
      created.id,
      "delete-external-lifecycle",
    )).resolves.toBe(true);
    await expect(externalAgentScheduleRepository.list({
      ...authorization,
      telegramChatId: null,
    })).resolves.toEqual({ items: [], total: 0 });
  });

  it("terminalizes a group run revoked between claim and Eve handoff", async () => {
    const setup = await fixture();
    const scheduledFor = new Date("2026-08-17T06:00:00.000Z");
    await externalAgentScheduleRepository.create(
      { familyId: setup.familyId, requestedBy: setup.ownerId },
      {
        capabilityAllowlist: [],
        firstRunAt: scheduledFor,
        operationKey: "create-pre-handoff-revocation",
        recurrence: { kind: "once" },
        scenarioPrompt: "Подготовь отчёт.",
        telegramChatId: "-100-external-schedule",
        timezone: "Europe/Moscow",
        title: "Отчёт",
        userRequest: "Пришли отчёт",
      },
    );
    const [job] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: scheduledFor,
    });
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "pre-handoff-revocation",
      familyId: setup.familyId,
      groupId: setup.groupId,
      kind: "scheduled",
      now: scheduledFor,
      scope: "group",
      telegramForumTopicId: null,
      userId: null,
    });
    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [setup.familyId, setup.ownerId],
    );

    await expect(agentScheduleDispatchRepository.markDispatchStarted(job!, {
      applicationSessionId: session.id,
    })).resolves.toBe(false);
    await sessionRepository.retireUnstartedScheduledSession(session.id);
    await expect(database().query(
      "SELECT status::text, error_code FROM agent_schedule_runs WHERE id = $1",
      [job!.runId],
    )).resolves.toMatchObject({
      rows: [{ error_code: "AGENT_SCHEDULE_DESTINATION_REVOKED", status: "failed" }],
    });
    await expect(database().query(
      "SELECT task_state::text, retired_at IS NOT NULL AS retired FROM conversation_sessions WHERE id = $1",
      [session.id],
    )).resolves.toMatchObject({ rows: [{ retired: true, task_state: "failed" }] });
  });

  it("keeps a terminal event that beats markRunning from leaving a leased run", async () => {
    const setup = await fixture();
    const scheduledFor = new Date("2026-08-17T06:00:00.000Z");
    await externalAgentScheduleRepository.create(
      { familyId: setup.familyId, requestedBy: setup.ownerId },
      {
        capabilityAllowlist: [],
        firstRunAt: scheduledFor,
        operationKey: "create-terminal-race",
        recurrence: { kind: "once" },
        scenarioPrompt: "Подготовь отчёт.",
        telegramChatId: "-100-external-schedule",
        timezone: "Europe/Moscow",
        title: "Отчёт",
        userRequest: "Пришли отчёт",
      },
    );
    const [job] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: scheduledFor,
    });
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "terminal-before-running",
      familyId: setup.familyId,
      groupId: setup.groupId,
      kind: "scheduled",
      now: scheduledFor,
      scope: "group",
      telegramForumTopicId: null,
      userId: null,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(job!, {
      applicationSessionId: session.id,
    });

    await expect(agentScheduleDispatchRepository.failRunByIdentityForNotification(
      job!.runId,
      "eve-terminal-race",
      "MODEL_SESSION_FAILED",
      new Date("2026-08-17T06:01:00.000Z"),
    )).resolves.toBe(true);
    await expect(agentScheduleDispatchRepository.markRunning(job!, {
      applicationSessionId: session.id,
      eveSessionId: "eve-terminal-race",
    })).resolves.toBeUndefined();
    await expect(database().query(
      "SELECT status::text, error_code FROM agent_schedule_runs WHERE id = $1",
      [job!.runId],
    )).resolves.toMatchObject({
      rows: [{ error_code: "MODEL_SESSION_FAILED", status: "failed" }],
    });
  });

  it("revalidates the current owner and destination immediately before Telegram delivery", async () => {
    const setup = await fixture();
    const scheduledFor = new Date("2026-08-17T06:00:00.000Z");
    await externalAgentScheduleRepository.create(
      { familyId: setup.familyId, requestedBy: setup.ownerId },
      {
        capabilityAllowlist: [],
        firstRunAt: scheduledFor,
        operationKey: "create-delivery-authorization",
        recurrence: { kind: "once" },
        scenarioPrompt: "Подготовь отчёт.",
        telegramChatId: "-100-external-schedule",
        timezone: "Europe/Moscow",
        title: "Отчёт",
        userRequest: "Пришли отчёт",
      },
    );
    const [job] = await agentScheduleDispatchRepository.claimDue({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: scheduledFor,
    });
    const session = await sessionRepository.prepareTurn({
      baseContinuationToken: "external-schedule-delivery-authorization",
      familyId: setup.familyId,
      groupId: setup.groupId,
      kind: "scheduled",
      now: scheduledFor,
      scope: "group",
      telegramForumTopicId: null,
      userId: null,
    });
    await agentScheduleDispatchRepository.markDispatchStarted(job!, {
      applicationSessionId: session.id,
    });
    await agentScheduleDispatchRepository.markRunning(job!, {
      applicationSessionId: session.id,
      eveSessionId: "eve-external-schedule",
    });
    const authorization = {
      applicationSessionId: session.id,
      eveSessionId: "eve-external-schedule",
      familyId: setup.familyId,
      groupId: setup.groupId,
      messageThreadId: null,
      ownerUserId: null,
      runId: job!.runId,
      scope: "group" as const,
      telegramChatId: job!.telegramChatId,
    };
    const executionAuthorization = {
      applicationSessionId: session.id,
      familyId: setup.familyId,
      groupId: setup.groupId,
      messageThreadId: null,
      ownerUserId: null,
      runId: job!.runId,
      scope: "group" as const,
      telegramChatId: job!.telegramChatId,
    };

    await expect(agentScheduleDispatchRepository.authorizeDelivery(authorization)).resolves.toBeUndefined();
    await expect(authorizeAgentScheduleExecution(executionAuthorization)).resolves.toBeUndefined();
    await database().query(
      "UPDATE family_memberships SET role = 'member' WHERE family_id = $1 AND user_id = $2",
      [setup.familyId, setup.ownerId],
    );
    await expect(agentScheduleDispatchRepository.authorizeDelivery(authorization)).rejects.toMatchObject({
      code: "AGENT_SCHEDULE_DELIVERY_AUTHORIZATION_REVOKED",
    });
    await expect(authorizeAgentScheduleExecution(executionAuthorization)).rejects.toMatchObject({
      code: "AGENT_SCHEDULE_EXECUTION_AUTHORIZATION_REVOKED",
    });
    await expect(agentScheduleDispatchRepository.failRunByIdentityForNotification(
      job!.runId,
      "eve-external-schedule",
      "MODEL_SESSION_FAILED",
      new Date("2026-08-17T06:01:00.000Z"),
    )).resolves.toBe(false);
    await expect(database().query(
      "SELECT status::text, error_code FROM agent_schedule_runs WHERE id = $1",
      [job!.runId],
    )).resolves.toMatchObject({
      rows: [{ error_code: "MODEL_SESSION_FAILED", status: "failed" }],
    });
  });
});
