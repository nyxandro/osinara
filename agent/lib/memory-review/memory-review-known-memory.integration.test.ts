/**
 * The silent review seeing what the memory already holds.
 *
 * Constructs covered:
 * - The batch prompt carries the records this conversation already stored.
 * - It carries the tail of messages the previous batch had already read.
 * - Both blocks are escaped the same way the batch itself is: they are untrusted data.
 * - A record without a slot is shown without the field, never as `"attribute": null`.
 * - Neither block leaks another family's memory or another conversation's messages.
 * - The property names already set for the authors of the batch are listed per author, so a new
 *   value is written under the same name and meets the version it replaces.
 * - The topics this conversation already keeps a discussion summary of are listed, newest first, so
 *   a continued discussion updates its summary instead of starting a second one.
 *
 * The review received only the fifty messages of its batch and nothing else, so it could not know
 * that the fact in front of it was written down last week in different words — and wrote it again.
 * The measurement in #204 counts 865 pairs of records about one subject at similarity 0.90 or
 * above on 1464 indexed records.
 */
import type { PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { selectMemoryReviewContext } from "./memory-review-known-memory.js";
import {
  MEMORY_REVIEW_AUTHOR_PROPERTY_LIMIT,
  MEMORY_REVIEW_DISCUSSION_SUMMARY_LIMIT,
  MEMORY_REVIEW_KNOWN_RECORD_LIMIT,
} from "./memory-review-config.js";
import { formatMemoryReviewContext } from "./memory-review-prompt.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("memory review known memory", () => {
  let conversationId: string;
  let familyId: string;
  let groupId: string;
  let otherFamilyId: string;
  let otherGroupId: string;
  let client: PoolClient;

  beforeEach(async () => {
    client ??= await database().connect();
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

  afterAll(async () => {
    client.release();
    await closeDatabase();
  });

  async function store(
    content: string,
    family = familyId,
    partition = groupId,
    attribute: string | null = null,
  ): Promise<void> {
    await database().query(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key, attribute)
       VALUES ($1, $2, 'review-author', 'group', 'fact', $3, 'test:review', 'model_high',
               'normal', $3, $4)`,
      [family, partition, content, attribute],
    );
  }

  async function message(
    sequence: number,
    text: string,
    conversation = conversationId,
    author = { name: "Автор", telegramUserId: "review-author", username: null as string | null },
  ): Promise<string> {
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_username, sender_is_bot, message_kind,
          content_text, sent_at)
       VALUES ($1, $2, $3, $3, 'user', 'telegram:' || $5, $5, $6, $7, false, 'text', $4, now())
       RETURNING id`,
      [conversation, groupId, sequence, text, author.telegramUserId, author.name, author.username],
    );
    return inserted.rows[0]!.id;
  }

  async function participant(telegramUserId: string, name: string): Promise<string> {
    const inserted = await database().query<{ id: string }>(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'group', $3, $4, $5, now(), now()) RETURNING id`,
      [conversationId, familyId, groupId, telegramUserId, name],
    );
    return inserted.rows[0]!.id;
  }

  async function storeAbout(
    participantId: string,
    content: string,
    attribute: string | null,
    options: { sensitivity?: "normal" | "sensitive" } = {},
  ): Promise<void> {
    await database().query(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key, attribute, origin_conversation_id,
          subject_participant_id, subject_conversation_id)
       VALUES ($1, $2, 'review-author', 'group', 'profile', $3, 'test:review', 'model_high',
               $5, $3, $4, $6, $7, $6)`,
      [familyId, groupId, content, attribute, options.sensitivity ?? "normal", conversationId, participantId],
    );
  }

  it("shows the records this conversation already stored", async () => {
    await store("Аня не ест глютен");

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [],
    });

    expect(context.known.map((record) => record.content)).toEqual(["Аня не ест глютен"]);
  });

  it("leaves the slot out of a record that has none, so there is no null for the review to copy", async () => {
    await store("Работает в «Ладоге»", familyId, groupId, "место работы");
    await store("Любит TDD");

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [],
    });

    const block = formatMemoryReviewContext(context);
    expect(block).toContain('"attribute":"место работы"');
    expect(block).not.toContain('"attribute":null');
    expect(context.known.find((record) => record.content === "Любит TDD")).not.toHaveProperty("attribute");
  });

  it("shows the tail of messages the previous batch had already read", async () => {
    await message(1, "Первое");
    await message(2, "Второе");
    await message(3, "Третье, уже в текущем пакете");

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "2",
      sourceEntryIds: [],
    });

    expect(context.reviewed.map((entry) => entry.contentText)).toEqual(["Первое", "Второе"]);
  });

  it("never reaches into another family's memory", async () => {
    await store("Чужой семейный факт", otherFamilyId, otherGroupId);

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [],
    });

    expect(context.known).toEqual([]);
  });

  it("keeps the block bounded however much the memory holds", async () => {
    for (let index = 0; index < MEMORY_REVIEW_KNOWN_RECORD_LIMIT + 5; index += 1) {
      await store(`Факт номер ${index}`);
    }

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [],
    });

    expect(context.known).toHaveLength(MEMORY_REVIEW_KNOWN_RECORD_LIMIT);
  });

  it("names the properties already set for the authors of the batch, and nobody else's", async () => {
    // Without the list the review named one property in new words — «гейминг» beside «gaming» —
    // and the new value never met the version it was meant to replace.
    const author = await participant("review-author", "Автор");
    const bystander = await participant("bystander", "Сосед");
    await storeAbout(author, "Работает в «Ладоге»", "место работы");
    await storeAbout(author, "Живёт в Казани", "город");
    await storeAbout(author, "Любит TDD", null);
    await storeAbout(author, "Диагноз", "здоровье", { sensitivity: "sensitive" });
    await storeAbout(bystander, "Живёт в Твери", "родной город");
    const source = await message(11, "Переехал в Москву", conversationId, {
      name: "Автор", telegramUserId: "review-author", username: "author_k",
    });

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [source],
    });

    expect(context.authorProperties).toEqual([
      { attributes: ["город", "место работы"], senderDisplayName: "Автор", senderUsername: "author_k" },
    ]);
    expect(formatMemoryReviewContext(context)).toContain("<untrusted_memory_review_author_properties>");
  });

  it("keeps each author's list bounded", async () => {
    const author = await participant("review-author", "Автор");
    for (let index = 0; index < MEMORY_REVIEW_AUTHOR_PROPERTY_LIMIT + 3; index += 1) {
      await storeAbout(author, `Факт ${index}`, `свойство ${String(index).padStart(2, "0")}`);
    }
    const source = await message(11, "Новость");

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [source],
    });

    expect(context.authorProperties[0]!.attributes).toHaveLength(MEMORY_REVIEW_AUTHOR_PROPERTY_LIMIT);
  });

  async function storeSummary(
    attribute: string,
    createdAt: string,
    options: { family?: string; partition?: string; sensitivity?: "normal" | "sensitive"; status?: "active" | "retracted" } = {},
  ): Promise<void> {
    await database().query(
      `INSERT INTO memory_items
         (family_id, group_id, author_telegram_user_id, scope, kind, content, source,
          confirmation, sensitivity, operation_key, attribute, claim_status, created_at)
       VALUES ($1, $2, 'review-author', 'group', 'fact', $3, 'test:review', 'model_high',
               $4, $3, $3, $5, $6)`,
      [options.family ?? familyId, options.partition ?? groupId, attribute, options.sensitivity ?? "normal",
        options.status ?? "active", createdAt],
    );
  }

  it("names the topics this conversation already keeps a discussion summary of, newest first", async () => {
    await storeSummary("итог: платный канал по эвалам", "2026-10-21T10:00:00Z");
    await storeSummary("итог: встречи по пятницам", "2026-10-22T10:00:00Z");
    await storeSummary("итог: снятая запись", "2026-10-20T10:00:00Z", { status: "retracted" });
    await storeSummary("итог: здоровье", "2026-10-22T11:00:00Z", { sensitivity: "sensitive" });
    await storeSummary("итог: чужое", "2026-10-22T12:00:00Z", { family: otherFamilyId, partition: otherGroupId });
    await store("Полезный ресурс", familyId, groupId, "ресурс");
    const author = await participant("review-author", "Автор");
    await storeAbout(author, "Итог про человека", "итог: про автора");

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [],
    });

    expect(context.discussionSummaries).toEqual(["итог: встречи по пятницам", "итог: платный канал по эвалам"]);
    const block = formatMemoryReviewContext(context);
    expect(block).toContain("<untrusted_memory_review_discussion_summaries>");
    expect(block).toContain("итог: встречи по пятницам");
  });

  it("keeps the summary list bounded and leaves the block out when there is none", async () => {
    const empty = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [],
    });
    expect(formatMemoryReviewContext(empty)).not.toContain("discussion_summaries");
    for (let index = 0; index < MEMORY_REVIEW_DISCUSSION_SUMMARY_LIMIT + 3; index += 1) {
      await storeSummary(`итог: тема ${String(index).padStart(2, "0")}`, `2026-10-${String(index + 1).padStart(2, "0")}T10:00:00Z`);
    }

    const context = await selectMemoryReviewContext(client, {
      conversationId, familyId, scope: "group", scopePartitionKey: groupId, predecessorSequence: "10",
      sourceEntryIds: [],
    });

    expect(context.discussionSummaries).toHaveLength(MEMORY_REVIEW_DISCUSSION_SUMMARY_LIMIT);
    expect(context.discussionSummaries[0]).toBe(`итог: тема ${String(MEMORY_REVIEW_DISCUSSION_SUMMARY_LIMIT + 2).padStart(2, "0")}`);
  });
});
