/**
 * The silent review seeing what the memory already holds.
 *
 * Constructs covered:
 * - The batch prompt carries the records this conversation already stored.
 * - It carries the tail of messages the previous batch had already read.
 * - Both blocks are escaped the same way the batch itself is: they are untrusted data.
 * - Neither block leaks another family's memory or another conversation's messages.
 *
 * The review received only the fifty messages of its batch and nothing else, so it could not know
 * that the fact in front of it was written down last week in different words — and wrote it again.
 * The measurement in #204 counts 865 pairs of records about one subject at similarity 0.90 or
 * above on 1464 indexed records.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { selectMemoryReviewContext } from "./memory-review-known-memory.js";
import { MEMORY_REVIEW_KNOWN_RECORD_LIMIT } from "./memory-review-config.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("memory review known memory", () => {
  let conversationId: string;
  let familyId: string;
  let groupId: string;
  let otherFamilyId: string;
  let otherGroupId: string;

  beforeEach(async () => {
    await database().query(
      "TRUNCATE memory_items_all, telegram_group_messages, application_conversations, telegram_groups, family_memberships, users, families CASCADE",
    );
    const families = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Разбор'), ('Соседи') RETURNING id",
    );
    familyId = families.rows[0]!.id;
    otherFamilyId = families.rows[1]!.id;
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, 'review-chat', 'Рабочий чат', 'external', 'all') RETURNING id`,
      [familyId],
    );
    groupId = group.rows[0]!.id;
    const otherGroup = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, 'neighbour-chat', 'Чужой чат', 'external', 'all') RETURNING id`,
      [otherFamilyId],
    );
    otherGroupId = otherGroup.rows[0]!.id;
    // The group conversation is created by a trigger on the group, not by hand.
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
      [groupId],
    );
    conversationId = conversation.rows[0]!.id;
  });

  afterAll(async () => closeDatabase());

  async function store(content: string, family = familyId, partition = groupId): Promise<void> {
    await database().query(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key)
       VALUES ($1, $2, 'review-author', 'group', 'fact', $3, 'test:review', 'model_high',
               'normal', $3)`,
      [family, partition, content],
    );
  }

  async function message(sequence: number, text: string, conversation = conversationId) {
    await database().query(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, $3, $3, 'user', 'telegram:review-author', 'review-author', 'Автор',
               false, 'text', $4, now())`,
      [conversation, groupId, sequence, text],
    );
  }

  it("shows the records this conversation already stored", async () => {
    await store("Аня не ест глютен");

    const context = await selectMemoryReviewContext({
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
    });

    expect(context.known.map((record) => record.content)).toEqual(["Аня не ест глютен"]);
  });

  it("shows the tail of messages the previous batch had already read", async () => {
    await message(1, "Первое");
    await message(2, "Второе");
    await message(3, "Третье, уже в текущем пакете");

    const context = await selectMemoryReviewContext({
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "2",
    });

    expect(context.reviewed.map((entry) => entry.contentText)).toEqual(["Первое", "Второе"]);
  });

  it("never reaches into another family's memory", async () => {
    await store("Чужой семейный факт", otherFamilyId, otherGroupId);

    const context = await selectMemoryReviewContext({
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
    });

    expect(context.known).toEqual([]);
  });

  it("keeps the block bounded however much the memory holds", async () => {
    for (let index = 0; index < MEMORY_REVIEW_KNOWN_RECORD_LIMIT + 5; index += 1) {
      await store(`Факт номер ${index}`);
    }

    const context = await selectMemoryReviewContext({
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
    });

    expect(context.known).toHaveLength(MEMORY_REVIEW_KNOWN_RECORD_LIMIT);
  });
});
