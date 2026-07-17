/**
 * PostgreSQL proactive delivery journal integration tests.
 *
 * Constructs covered:
 * - Personal delivery isolation and family-group sharing.
 * - Pending context uses the application-session cursor exactly once.
 * - Historical search returns only the caller's current trust zone.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { proactiveDeliveryRepository } from "./proactive-delivery-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("proactive delivery repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE proactive_deliveries, conversation_sessions, telegram_groups, family_memberships, users, families CASCADE",
    );
  });
  afterAll(async () => closeDatabase());

  it("isolates personal history and advances pending context after Eve accepts the turn", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Журнал') RETURNING id",
    );
    const users = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('delivery-owner', 'Владелец'), ('delivery-member', 'Участник') RETURNING id`,
    );
    const ownerId = users.rows[0]!.id;
    const memberId = users.rows[1]!.id;
    await database().query(
      `INSERT INTO family_memberships (family_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [family.rows[0]!.id, ownerId, memberId],
    );
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, owner_user_id, group_id, scope,
          conversation_key, continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'delivery-owner::',
               'delivery-owner::', now(), now()) RETURNING id`,
      [family.rows[0]!.id, ownerId],
    );

    await proactiveDeliveryRepository.record({
      content: "Сводка по искусственному интеллекту",
      deliveredAt: new Date("2026-07-17T06:01:00.000Z"),
      familyId: family.rows[0]!.id,
      groupId: null,
      messageThreadId: null,
      ownerUserId: ownerId,
      scheduledFor: new Date("2026-07-17T06:00:00.000Z"),
      scope: "personal",
      sourceId: "00000000-0000-4000-8000-000000000101",
      sourceKind: "agent_schedule",
      telegramChatId: "delivery-owner",
      telegramMessageId: "501",
      title: "Новости ИИ",
    });

    const authorization = {
      familyId: family.rows[0]!.id,
      groupId: null,
      ownerUserId: ownerId,
      scope: "personal" as const,
      telegramChatId: "delivery-owner",
      messageThreadId: null,
    };
    const pending = await proactiveDeliveryRepository.listPendingContext({
      ...authorization,
      applicationSessionId: session.rows[0]!.id,
      now: new Date("2026-07-17T07:00:00.000Z"),
    });
    expect(pending?.context).toContain("Сводка по искусственному интеллекту");

    await proactiveDeliveryRepository.advanceSessionCursor(session.rows[0]!.id, pending!.cursor);
    await expect(proactiveDeliveryRepository.listPendingContext({
      ...authorization,
      applicationSessionId: session.rows[0]!.id,
      now: new Date("2026-07-17T07:01:00.000Z"),
    })).resolves.toBeNull();

    await expect(proactiveDeliveryRepository.list({
      ...authorization,
      query: "искусственный интеллект",
      sourceKind: "agent_schedule",
    })).resolves.toHaveLength(1);
    await expect(proactiveDeliveryRepository.list({
      ...authorization,
      ownerUserId: memberId,
      telegramChatId: "delivery-member",
      query: null,
      sourceKind: null,
    })).resolves.toEqual([]);

    // Family deliveries are shared only through the exact registered group and topic.
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-delivery', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
      [family.rows[0]!.id],
    );
    await proactiveDeliveryRepository.record({
      content: "Семейное напоминание",
      deliveredAt: new Date("2026-07-17T08:01:00.000Z"),
      familyId: family.rows[0]!.id,
      groupId: group.rows[0]!.id,
      messageThreadId: "77",
      ownerUserId: null,
      scheduledFor: new Date("2026-07-17T08:00:00.000Z"),
      scope: "family",
      sourceId: "00000000-0000-4000-8000-000000000102",
      sourceKind: "reminder",
      telegramChatId: "-100-delivery",
      telegramMessageId: "502",
      title: null,
    });
    await expect(proactiveDeliveryRepository.list({
      familyId: family.rows[0]!.id,
      groupId: group.rows[0]!.id,
      messageThreadId: "77",
      ownerUserId: null,
      query: null,
      scope: "family",
      sourceKind: "reminder",
      telegramChatId: "-100-delivery",
    })).resolves.toEqual([
      expect.objectContaining({ content: "Семейное напоминание", sourceKind: "reminder" }),
    ]);
  });
});
