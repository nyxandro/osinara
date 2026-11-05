/**
 * Disconnection of an external group against PostgreSQL (#464, #465).
 *
 * Constructs covered:
 * - Disconnection and reconnection keep the row; reconnection records the pause; a family group and
 *   another family's group are refused.
 * - The message paths stop seeing a disconnected group: `findGroup`, `acceptChatUpdate`.
 * - The bot's membership events: removal disconnects once, older or repeated events change nothing.
 * - A disconnected group's due schedule occurrence passes without a run, and its reminder without a
 *   delivery; its keys leave the proxy.
 * - Removal returns the group's sandbox sessions; the purge deletes only the chat's finished raw copies.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { passDisconnectedGroupSchedules } from "../agent-schedules/agent-schedule-disconnected-group.js";
import { apiKeyRepository } from "../api-keys/api-key-repository.js";
import { reminderDispatchRepository } from "../reminders/reminder-dispatch-repository.js";
import { closeDatabase, database } from "../database.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { telegramIngressRepository } from "../telegram-ingress-repository.js";
import { telegramRepository } from "../telegram-repository.js";
import { groupConnectionRepository, isGroupIdDisconnected, isTelegramGroupDisconnected } from "./group-connection-repository.js";
import { purgeChatIngressCopies } from "./group-ingress-purge.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

const EXTERNAL = "-1001";
const FAMILY_CHAT = "-1002";

async function fixture() {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Связь') RETURNING id");
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ('connection-owner', 'Owner') RETURNING id",
  );
  const familyId = family.rows[0]!.id;
  const ownerId = owner.rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, ownerId]);
  const groups = await database().query<{ id: string; telegram_chat_id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist, skill_allowlist, telegram_chat_type)
     VALUES ($1, $2, 'Внешняя', 'external', 'all', '{}', '{}', 'supergroup'),
            ($1, $3, 'Семья', 'family_private', 'all', '{}', '{}', 'supergroup')
     RETURNING id, telegram_chat_id`,
    [familyId, EXTERNAL, FAMILY_CHAT],
  );
  const groupId = groups.rows.find((row) => row.telegram_chat_id === EXTERNAL)!.id;
  return { familyId, groupId, ownerId, request: { familyId, requestedBy: ownerId, telegramChatId: EXTERNAL } };
}

describeWithDatabase("group connection", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_ingress_ignored_updates, telegram_ingress_updates, telegram_ingress_continuation_aliases,
                telegram_ingress_queues, agent_schedules, reminders, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });
  afterAll(closeDatabase);

  it("disconnects and reconnects keeping the row, and records the pause", async () => {
    const { groupId, request } = await fixture();

    expect(await groupConnectionRepository.disconnect(request)).toMatchObject({ groupId, status: "disconnected", title: "Внешняя" });
    expect(await groupConnectionRepository.disconnect(request)).toMatchObject({ status: "already_disconnected" });
    expect(await isTelegramGroupDisconnected(EXTERNAL)).toBe(true);
    expect(await isGroupIdDisconnected(groupId)).toBe(true);
    expect(await telegramRepository.findGroup(EXTERNAL, "supergroup")).toBeNull();

    const reconnected = await groupConnectionRepository.reconnect(request);
    expect(reconnected).toMatchObject({ status: "reconnected" });
    expect(await groupConnectionRepository.reconnect(request)).toMatchObject({ status: "already_connected" });
    const found = await telegramRepository.findGroup(EXTERNAL, "supergroup");
    expect(found?.lastPause).toMatchObject({ afterSequence: "0" });
    expect(found?.lastPause?.endedAt.getTime()).toBeGreaterThanOrEqual(found!.lastPause!.startedAt.getTime());
    expect(await isTelegramGroupDisconnected(EXTERNAL)).toBe(false);
  });

  it("refuses a family group and a group of another family", async () => {
    const { familyId, ownerId } = await fixture();

    await expect(groupConnectionRepository.disconnect({ familyId, requestedBy: ownerId, telegramChatId: FAMILY_CHAT }))
      .rejects.toMatchObject({ code: "AGENT_GROUP_DISCONNECT_EXTERNAL_ONLY" });
    await expect(groupConnectionRepository.disconnect({ familyId, requestedBy: ownerId, telegramChatId: "-1009" }))
      .rejects.toMatchObject({ code: "AGENT_GROUP_NOT_FOUND" });
  });

  it("keeps nothing a disconnected or unregistered group sends", async () => {
    const { request } = await fixture();

    expect(await telegramIngressRepository.acceptChatUpdate({ chatId: EXTERNAL, chatType: "supergroup", updateId: "11" })).toBe(true);
    await groupConnectionRepository.disconnect(request);
    expect(await telegramIngressRepository.acceptChatUpdate({ chatId: EXTERNAL, chatType: "supergroup", updateId: "12" })).toBe(false);
    expect(await telegramIngressRepository.acceptChatUpdate({ chatId: "-1009", chatType: "supergroup", updateId: "13" })).toBe(false);
    const ignored = await database().query("SELECT update_id::text FROM telegram_ingress_ignored_updates ORDER BY update_id");
    expect(ignored.rows.map((row) => row.update_id)).toEqual(["12", "13"]);
  });

  it("disconnects once when the bot is removed and ignores older or repeated news", async () => {
    await fixture();
    const at = new Date("2026-11-04T20:00:00.000Z");

    expect(await groupConnectionRepository.recordBotMembership({ changedAt: at, member: false, telegramChatId: EXTERNAL }))
      .toMatchObject({ change: "disconnected", title: "Внешняя" });
    expect(await groupConnectionRepository.recordBotMembership({ changedAt: at, member: false, telegramChatId: EXTERNAL }))
      .toEqual({ change: "none" });
    expect(await groupConnectionRepository.recordBotMembership({ changedAt: new Date(at.getTime() - 1_000), member: true, telegramChatId: EXTERNAL }))
      .toEqual({ change: "none" });
    expect(await groupConnectionRepository.recordBotMembership({ changedAt: new Date(at.getTime() + 1_000), member: true, telegramChatId: EXTERNAL }))
      .toMatchObject({ change: "rejoined_while_disconnected" });
    const reason = await database().query("SELECT disconnected_reason FROM telegram_groups WHERE telegram_chat_id = $1", [EXTERNAL]);
    expect(reason.rows[0]).toEqual({ disconnected_reason: "bot_removed" });
    expect(await groupConnectionRepository.recordBotMembership({ changedAt: at, member: false, telegramChatId: FAMILY_CHAT }))
      .toEqual({ change: "none" });
  });

  it("passes a disconnected group's due occurrence without a run", async () => {
    const { familyId, groupId, ownerId, request } = await fixture();
    const schedule = await database().query<{ id: string }>(
      `INSERT INTO agent_schedules
         (family_id, author_user_id, scope, group_id, title, user_request, scenario_prompt, timezone,
          recurrence_kind, recurrence_interval, recurrence_anchor_local, next_run_at, telegram_chat_id, telegram_chat_type)
       VALUES ($1, $2, 'group', $3, 'Сводка', 'Запрос', 'Сценарий', 'UTC', 'daily', 1,
               timestamp '2026-11-01 09:00:00', timestamptz '2026-11-05 09:00:00+00', $4, 'supergroup')
       RETURNING id`,
      [familyId, ownerId, groupId, EXTERNAL],
    );
    await groupConnectionRepository.disconnect(request);
    const client = await database().connect();
    try {
      expect(await passDisconnectedGroupSchedules(client, new Date("2026-11-05T09:30:00.000Z"))).toBe(1);
    } finally {
      client.release();
    }
    const after = await database().query(
      "SELECT status, next_run_at, (SELECT count(*)::int FROM agent_schedule_runs WHERE schedule_id = $1) AS runs FROM agent_schedules WHERE id = $1",
      [schedule.rows[0]!.id],
    );
    expect(after.rows[0]).toMatchObject({ runs: 0, status: "active" });
    expect((after.rows[0] as { next_run_at: Date }).next_run_at.toISOString()).toBe("2026-11-06T09:00:00.000Z");
  });

  it("passes a disconnected group's due reminder without delivery", async () => {
    const { familyId, groupId, request } = await fixture();
    const reminder = await database().query<{ id: string }>(
      `INSERT INTO reminders
         (family_id, scope, group_id, author_telegram_user_id, content, timezone, telegram_chat_id,
          recurrence_unit, recurrence_interval, recurrence_anchor_local, due_at, available_at)
       VALUES ($1, 'group', $2, '202', 'Созвон', 'UTC', $3, 'daily', 1, timestamp '2026-11-01 09:00:00',
               timestamptz '2026-11-05 09:00:00+00', timestamptz '2026-11-05 09:00:00+00')
       RETURNING id`,
      [familyId, groupId, EXTERNAL],
    );
    await groupConnectionRepository.disconnect(request);
    const at = new Date("2026-11-05T09:00:30.000Z");
    const [claimed] = await reminderDispatchRepository.claimDue({ leaseMilliseconds: 300_000, limit: 10, now: at });

    await reminderDispatchRepository.skipWhileGroupDisconnected(claimed!, at);

    const after = await database().query(
      `SELECT status, due_at, (SELECT count(*)::int FROM proactive_deliveries WHERE source_id = $1) AS deliveries
         FROM reminders WHERE id = $1`,
      [reminder.rows[0]!.id],
    );
    expect(after.rows[0]).toMatchObject({ deliveries: 0, status: "active" });
    expect((after.rows[0] as { due_at: Date }).due_at.toISOString()).toBe("2026-11-06T09:00:00.000Z");
  });

  it("returns the sandbox sessions on removal and purges only the chat's finished raw copies", async () => {
    const { request } = await fixture();
    const queue = await database().query<{ id: string }>(
      "INSERT INTO telegram_ingress_queues (current_continuation_key) VALUES ($1) RETURNING id", [`${EXTERNAL}::`],
    );
    await database().query(
      `INSERT INTO telegram_ingress_updates (update_id, queue_id, ingress_continuation_key, payload, status)
       VALUES (21, $1, $2, '{}'::jsonb, 'completed'), (22, $1, $2, '{}'::jsonb, 'pending'), (23, $1, '-10010::', '{}'::jsonb, 'completed')`,
      [queue.rows[0]!.id, `${EXTERNAL}::`],
    );

    expect(await purgeChatIngressCopies(EXTERNAL)).toBe(1);
    const left = await database().query("SELECT update_id::text FROM telegram_ingress_updates ORDER BY update_id");
    expect(left.rows.map((row) => row.update_id)).toEqual(["22", "23"]);

    await expect(telegramGroupAdministrationRepository.removeRegistration(request))
      .resolves.toMatchObject({ sandboxThreadIds: [], title: "Внешняя" });
  });

  it("reads the proxy grants through the disconnected-group filter", async () => {
    await fixture();
    expect(await apiKeyRepository.listProjectionGrants()).toEqual([]);
  });
});
