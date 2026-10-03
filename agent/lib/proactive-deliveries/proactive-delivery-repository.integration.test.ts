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

  it("isolates personal history and advances pending context after the runtime accepts the turn", async () => {
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
         (thread_id, generation, family_id, owner_user_id, group_id, scope, kind, task_state,
           conversation_key, continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, NULL, 'personal', 'proactive', 'running', 'delivery-owner::',
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
      deliveredAfter: null,
      deliveredBefore: null,
      limit: 10,
      query: "искусственный интеллект",
      sourceKind: "agent_schedule",
    })).resolves.toMatchObject({ items: [expect.objectContaining({
      deliveryId: expect.any(String),
      sourceId: "00000000-0000-4000-8000-000000000101",
    })], nextCursor: null });
    await expect(proactiveDeliveryRepository.list({
      ...authorization,
      deliveredAfter: null,
      deliveredBefore: null,
      limit: 10,
      ownerUserId: memberId,
      telegramChatId: "delivery-member",
      query: null,
      sourceKind: null,
    })).resolves.toEqual({ items: [], nextCursor: null });

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
      deliveredAfter: null,
      deliveredBefore: null,
      limit: 10,
      query: null,
      scope: "family",
      sourceKind: "reminder",
      telegramChatId: "-100-delivery",
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ content: "Семейное напоминание", sourceKind: "reminder" })],
      nextCursor: null,
    });
  });

  it("paginates delivery history beyond ten records and respects an exact date window", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Пагинация доставок') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('delivery-page', 'Участник') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const authorization = {
      familyId: family.rows[0]!.id,
      groupId: null,
      messageThreadId: null,
      ownerUserId: user.rows[0]!.id,
      scope: "personal" as const,
      telegramChatId: "delivery-page",
    };
    for (let index = 1; index <= 12; index += 1) {
      await proactiveDeliveryRepository.record({
        ...authorization,
        content: `Доставка ${index}`,
        deliveredAt: new Date(
          `2026-07-${String(index === 10 ? 11 : index).padStart(2, "0")}T10:00:00.000Z`,
        ),
        scheduledFor: new Date(`2026-07-${String(index).padStart(2, "0")}T09:00:00.000Z`),
        sourceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        sourceKind: "reminder",
        telegramMessageId: String(600 + index),
        title: null,
      });
    }

    const base = {
      ...authorization,
      deliveredAfter: new Date("2026-07-02T10:00:00.000Z"),
      deliveredBefore: new Date("2026-07-11T10:00:00.000Z"),
      limit: 4,
      query: null,
      sourceKind: null,
    };
    const first = await proactiveDeliveryRepository.list(base);
    const second = await proactiveDeliveryRepository.list({ ...base, cursor: first.nextCursor! });
    const third = await proactiveDeliveryRepository.list({ ...base, cursor: second.nextCursor! });
    const items = [...first.items, ...second.items, ...third.items];

    expect(items.map((item) => item.content)).toEqual([
      "Доставка 11", "Доставка 10", "Доставка 9", "Доставка 8", "Доставка 7",
      "Доставка 6", "Доставка 5", "Доставка 4", "Доставка 3", "Доставка 2",
    ]);
    expect(new Set(items.map((item) => item.deliveryId))).toHaveLength(10);
    expect(items.at(-1)).toMatchObject({
      sourceId: "00000000-0000-4000-8000-000000000002",
    });
    expect(third.nextCursor).toBeNull();
    await expect(proactiveDeliveryRepository.list({ ...base, cursor: "invalid" }))
      .rejects.toMatchObject({ code: "AGENT_PROACTIVE_DELIVERY_CURSOR_INVALID" });
  });
});
