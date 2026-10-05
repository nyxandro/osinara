/**
 * PostgreSQL Telegram group journal ancestry and retention integration tests.
 *
 * Constructs covered:
 * - `telegramGroupJournalRepository`: reply ancestry, retention, and unavailable targets.
 * - `telegramGroupAttachmentRepository`: lazy capture for observed and raw reply targets.
 * - `telegramGroupAdministrationRepository`: family-scoped cascading group removal.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES } from "../config.js";
import { telegramGroupAttachmentRepository } from "./attachments/telegram-group-attachment-repository.js";
import { closeDatabase, database } from "./database.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";
import { telegramGroupJournalRepository as productionTelegramGroupJournalRepository } from "./telegram-group-journal-repository.js";
import { recordVerifiedHumanTelegramMessage } from "./telegram-group-journal.integration-fixtures.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

// Database integration tests must never run against a non-test database.
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error(
      "AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL",
    );
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

// Existing journal tests use only verified human fixtures; retain the complete repository surface
// while routing inbound writes through the actor-validating test boundary.
const telegramGroupJournalRepository = {
  ...productionTelegramGroupJournalRepository,
  record: recordVerifiedHumanTelegramMessage,
};

async function createOwnedFamily(suffix: string): Promise<{ familyId: string; ownerId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [`Семья ${suffix}`],
  );
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2) RETURNING id`,
    [`owner-${suffix}`, `Владелец ${suffix}`],
  );
  const familyId = family.rows[0]!.id;
  const ownerId = user.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, ownerId],
  );
  return { familyId, ownerId };
}

function message(input: {
  id: string;
  text?: string;
  withPhoto?: boolean;
}): TelegramMessage {
  return {
    attachments: input.withPhoto ? [{ fileId: "photo-file", kind: "photo" }] : [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false, username: "anna" },
    messageId: input.id,
    raw: {
      date: 1_700_000_000 + Number(input.id),
      ...(input.withPhoto ? { photo: [{ file_id: "photo-file" }] } : {}),
    },
    text: input.text ?? "",
  };
}

describeWithDatabase("Telegram group journal ancestry and retention", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE invitations, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("includes the current reply target and two ancestors before an existing session cursor", async () => {
    const { familyId, ownerId } = await createOwnedFamily("current-reply-ancestry");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "addressed_only",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Внешняя группа",
      toolAllowlist: [],
      type: "external",
    });
    const grandparent = message({ id: "81", text: "Начало ветки" });
    await telegramGroupJournalRepository.record(group.groupId, grandparent);
    const parent = message({ id: "82", text: "Продолжение ветки" });
    await telegramGroupJournalRepository.record(group.groupId, {
      ...parent,
      replyToMessage: {
        chat: grandparent.chat,
        from: grandparent.from,
        messageId: grandparent.messageId,
      },
    });
    const target = message({ id: "83", text: "Почему используется эта модель?" });
    await telegramGroupJournalRepository.record(group.groupId, {
      ...target,
      replyToMessage: {
        chat: parent.chat,
        from: parent.from,
        messageId: parent.messageId,
      },
    });
    await telegramGroupJournalRepository.record(group.groupId, message({ id: "84", text: "cursor" }));
    const current = await telegramGroupJournalRepository.record(group.groupId, {
      ...message({ id: "85", text: "Ты видишь, на что я ответил?" }),
      replyToMessage: {
        chat: target.chat,
        from: target.from,
        messageId: target.messageId,
      },
    });

    const incremental = await telegramGroupJournalRepository.listIncremental({
      afterSequence: "4",
      anchorEntryId: current.entryId,
      applicationSessionId: "00000000-0000-4000-8000-000000000099",
      beforeSequence: current.sequenceId,
      groupId: group.groupId,
      limit: 50,
      messageThreadId: null,
    });

    expect(current).toMatchObject({
      replyTargetUnavailable: false,
      replyToSequenceId: "3",
    });
    expect(incremental.entries).toMatchObject([
      { contentText: "Начало ветки", sequenceId: "1" },
      { contentText: "Продолжение ветки", replyToSequenceId: "1", sequenceId: "2" },
      { contentText: "Почему используется эта модель?", replyToSequenceId: "2", sequenceId: "3" },
    ]);
  });

  it("captures an unobserved raw reply attachment without a second timeline entry", async () => {
    const { familyId, ownerId } = await createOwnedFamily("raw-reply-image");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "addressed_only",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Семейная группа",
      toolAllowlist: [],
      type: "family_private",
    });
    const currentMessage = message({ id: "62", text: "Что на фото?" });
    const current = await telegramGroupJournalRepository.record(group.groupId, currentMessage);
    const rawTarget = message({ id: "61", withPhoto: true });

    const reference = await telegramGroupAttachmentRepository.captureReplyTarget(
      group.groupId,
      current.entryId,
      rawTarget,
    );
    const count = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages WHERE group_id = $1",
      [group.groupId],
    );

    expect(reference).toMatchObject({ kind: "photo", telegramMessageId: "61" });
    expect(count.rows[0]?.count).toBe("1");
    await expect(telegramGroupAttachmentRepository.find({
      familyId,
      groupId: group.groupId,
      groupType: "family_private",
      role: "owner",
      telegramChatType: "supergroup",
      userId: ownerId,
    }, reference!.attachmentId)).resolves.toMatchObject({ messageId: "61" });
    await expect(telegramGroupAttachmentRepository.list({
      familyId,
      groupId: group.groupId,
      groupType: "family_private",
      role: "owner",
      telegramChatType: "supergroup",
      userId: ownerId,
    }, { limit: 50, messageThreadId: null })).resolves.toMatchObject({
      items: [{ telegramMessageId: "61" }],
      nextCursor: null,
    });
  });

  it("enriches an observed reply target whose attachment reference is missing", async () => {
    const { familyId, ownerId } = await createOwnedFamily("observed-reply-image");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "addressed_only",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Внешняя группа",
      toolAllowlist: ["inspect_workspace_image"],
      type: "external",
    });
    const target = message({ id: "71", withPhoto: true });
    const targetEntry = await telegramGroupJournalRepository.record(group.groupId, target);
    const reply = message({ id: "72", text: "Что на фото?" });
    const current = await telegramGroupJournalRepository.record(group.groupId, {
      ...reply,
      replyToMessage: { chat: target.chat, from: target.from, messageId: target.messageId },
    });

    const reference = await telegramGroupAttachmentRepository.captureReplyTarget(
      group.groupId,
      current.entryId,
      target,
    );
    const stored = await database().query<{ id: string }>(
      "SELECT id FROM telegram_group_messages WHERE attachment_file_id IS NOT NULL",
    );

    expect(reference).toMatchObject({ kind: "photo", telegramMessageId: "71" });
    expect(stored.rows).toEqual([{ id: targetEntry.entryId }]);
  });

  it("physically prunes messages beyond the configured per-group retention cap", async () => {
    const { familyId, ownerId } = await createOwnedFamily("retention");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external",
    });
    await database().query(
      `INSERT INTO telegram_group_messages
         (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       SELECT $1, value, 'user', 'telegram:101', value, '101', 'Анна', false, 'text', 'seed', now()
       FROM generate_series(1, $2) AS value`,
      [group.groupId, TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES],
    );
    await database().query(
      `INSERT INTO telegram_group_message_ids (group_id, telegram_message_id, entry_id)
       SELECT group_id, telegram_message_id, id
       FROM telegram_group_messages
       WHERE group_id = $1 AND sequence_id = 1`,
      [group.groupId],
    );
    const currentMessage = message({
      id: String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES + 1),
      text: "новая",
    });
    const current = await telegramGroupJournalRepository.record(group.groupId, {
      ...currentMessage,
      replyToMessage: {
        chat: currentMessage.chat,
        from: currentMessage.from,
        messageId: "1",
      },
    });

    const retained = await database().query<{ count: string; minimum: string }>(
      `SELECT count(*)::text AS count, min(telegram_message_id)::text AS minimum
       FROM telegram_group_messages WHERE group_id = $1`,
      [group.groupId],
    );
    expect(retained.rows[0]).toEqual({
      count: String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES),
      minimum: "2",
    });
    const newest = await database().query<{ maximum: string }>(
      `SELECT max(sequence_id)::text AS maximum
       FROM telegram_group_messages WHERE group_id = $1`,
      [group.groupId],
    );
    expect(newest.rows[0]?.maximum).toBe(String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES + 1));
    expect(current).toMatchObject({
      replyTargetUnavailable: true,
      replyToSequenceId: null,
    });
  });

  it("removes only a same-family group and cascades its journal and memory", async () => {
    const { familyId, ownerId } = await createOwnedFamily("delete-owner");
    const { familyId: otherFamilyId, ownerId: otherOwnerId } =
      await createOwnedFamily("delete-other");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external",
    });
    await telegramGroupJournalRepository.record(group.groupId, message({ id: "1", text: "данные" }));
    await database().query(
      `INSERT INTO memory_items
         (family_id, group_id, scope, author_telegram_user_id, kind, content, source,
          confirmation, sensitivity, operation_key)
       VALUES ($1, $2, 'group', 'delete-owner', 'fact', 'value', 'test',
               'user_confirmed', 'normal', 'delete-group-memory')`,
      [familyId, group.groupId],
    );
    await expect(
      telegramGroupAdministrationRepository.removeRegistration({
        familyId: otherFamilyId,
        requestedBy: otherOwnerId,
        telegramChatId: "-1001",
      }),
    ).rejects.toThrowError(/AGENT_GROUP_NOT_FOUND/);
    await telegramGroupAdministrationRepository.removeRegistration({
      familyId,
      requestedBy: ownerId,
      telegramChatId: "-1001",
    });

    for (const table of [
      "telegram_groups",
      "telegram_group_messages",
      "memory_items",
    ]) {
      const result = await database().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(result.rows[0]?.count).toBe("0");
    }
  });
});
