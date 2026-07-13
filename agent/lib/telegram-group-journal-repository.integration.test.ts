/**
 * PostgreSQL Telegram group journal integration tests.
 *
 * Constructs covered:
 * - `telegramGroupJournalRepository`: normalized insertion, deduplication, topic isolation, ordering, and retention.
 * - `telegramGroupAdministrationRepository`: explicit mode persistence and family-scoped cascading removal.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES } from "../config.js";
import { closeDatabase, database } from "./database.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";
import { telegramGroupJournalRepository } from "./telegram-group-journal-repository.js";
import { telegramRepository } from "./telegram-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

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
  threadId?: number;
  withPhoto?: boolean;
}): TelegramMessage {
  return {
    attachments: input.withPhoto ? [{ fileId: "photo-file", kind: "photo" }] : [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false, username: "anna" },
    messageId: input.id,
    ...(input.threadId === undefined ? {} : { messageThreadId: input.threadId }),
    raw: {
      date: 1_700_000_000 + Number(input.id),
      ...(input.withPhoto ? { photo: [{ file_id: "photo-file" }] } : {}),
    },
    text: input.text ?? "",
  };
}

describeWithDatabase("Telegram group journal repositories", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE invitations, memory_items,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("persists an explicit group mode and returns it from Telegram lookup", async () => {
    const { familyId, ownerId } = await createOwnedFamily("mode");

    await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: ["remember"],
      type: "external_private",
    });

    await expect(telegramRepository.findGroup("-1001")).resolves.toMatchObject({
      familyId,
      messageMode: "all",
      telegramChatId: "-1001",
      toolAllowlist: ["remember"],
    });
  });

  it("physically clears collected messages when a group switches to addressed-only mode", async () => {
    const { familyId, ownerId } = await createOwnedFamily("mode-downgrade");
    const registration = {
      familyId,
      messageMode: "all" as const,
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external_private" as const,
    };
    const group = await telegramGroupAdministrationRepository.registerGroup(registration);
    await telegramGroupJournalRepository.record(group.groupId, message({ id: "1", text: "данные" }));

    await telegramGroupAdministrationRepository.registerGroup({
      ...registration,
      messageMode: "addressed_only",
    });

    const retained = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages WHERE group_id = $1",
      [group.groupId],
    );
    expect(retained.rows[0]?.count).toBe("0");
  });

  it("replaces the group and purges journal data when its trust-zone type changes", async () => {
    const { familyId, ownerId } = await createOwnedFamily("type-change");
    const initial = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Семейная группа",
      toolAllowlist: [],
      type: "family_private",
    });
    await telegramGroupJournalRepository.record(initial.groupId, message({ id: "1", text: "семейные данные" }));

    const replacement = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Внешняя группа",
      toolAllowlist: ["remember"],
      type: "external_public",
    });

    expect(replacement.groupId).not.toBe(initial.groupId);
    const retained = await database().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_group_messages",
    );
    expect(retained.rows[0]?.count).toBe("0");
  });

  it("deduplicates messages and reads numeric order only from the same forum topic", async () => {
    const { familyId, ownerId } = await createOwnedFamily("journal");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external_private",
    });

    await expect(
      telegramGroupJournalRepository.record(group.groupId, message({ id: "9", text: "девять", threadId: 7 })),
    ).resolves.toBe("inserted");
    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: "10", text: "десять", threadId: 7 }),
    );
    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: "11", text: "другая тема", threadId: 8 }),
    );
    await expect(
      telegramGroupJournalRepository.record(group.groupId, message({ id: "10", text: "повтор", threadId: 7 })),
    ).resolves.toBe("duplicate");

    const entries = await telegramGroupJournalRepository.listBefore({
      beforeTelegramMessageId: "12",
      groupId: group.groupId,
      limit: 50,
      messageThreadId: "7",
    });
    expect(entries.map((entry) => [entry.telegramMessageId, entry.contentText])).toEqual([
      ["9", "девять"],
      ["10", "десять"],
    ]);
  });

  it("stores media metadata without downloading or persisting Telegram raw payloads", async () => {
    const { familyId, ownerId } = await createOwnedFamily("media");
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId,
      messageMode: "all",
      requestedBy: ownerId,
      telegramChatId: "-1001",
      title: "Группа",
      toolAllowlist: [],
      type: "external_private",
    });

    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: "1", withPhoto: true }),
    );
    const entries = await telegramGroupJournalRepository.listBefore({
      beforeTelegramMessageId: "2",
      groupId: group.groupId,
      limit: 50,
      messageThreadId: null,
    });

    expect(entries[0]).toMatchObject({ contentText: null, messageKind: "photo" });
    const columns = await database().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'telegram_group_messages'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("raw");
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
      type: "external_private",
    });
    await database().query(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, telegram_user_id, sender_display_name,
          sender_is_bot, message_kind, content_text, sent_at)
       SELECT $1, value, '101', 'Анна', false, 'text', 'seed', now()
       FROM generate_series(1, $2) AS value`,
      [group.groupId, TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES],
    );

    await telegramGroupJournalRepository.record(
      group.groupId,
      message({ id: String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES + 1), text: "новая" }),
    );

    const retained = await database().query<{ count: string; minimum: string }>(
      `SELECT count(*)::text AS count, min(telegram_message_id)::text AS minimum
       FROM telegram_group_messages WHERE group_id = $1`,
      [group.groupId],
    );
    expect(retained.rows[0]).toEqual({
      count: String(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES),
      minimum: "2",
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
      type: "external_private",
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
      telegramGroupAdministrationRepository.removeGroup({
        familyId: otherFamilyId,
        requestedBy: otherOwnerId,
        telegramChatId: "-1001",
      }),
    ).rejects.toThrowError(/AGENT_GROUP_NOT_FOUND/);
    await telegramGroupAdministrationRepository.removeGroup({
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
