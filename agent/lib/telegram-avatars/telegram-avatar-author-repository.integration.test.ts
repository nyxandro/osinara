/**
 * PostgreSQL integration tests for the author of a message whose avatar is inspected.
 *
 * Constructs covered:
 * - `telegramAvatarAuthorRepository.find`: a message number resolves only inside the current chat —
 *   the private chat of the user or the registered group — and names its author's Telegram id and
 *   kind; the same number in another chat is never reached.
 */
import type { TelegramMessage } from "../../runtime/telegram/inbound.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "../conversation-repository.js";
import { conversationTimelineRepository } from "../conversation-timeline-repository.js";
import { closeDatabase, database } from "../database.js";
import { telegramGroupAdministrationRepository } from "../telegram-group-administration-repository.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { telegramInboundActor } from "../telegram-inbound-actor.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { telegramAvatarAuthorRepository } from "./telegram-avatar-author-repository.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

// Database integration tests must never run against a non-test database.
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error("AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test");
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const OWNER_TELEGRAM_ID = "5001";

function groupMessage(input: { chatId: string; from: TelegramMessage["from"]; messageId: string }): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: input.chatId, title: "Группа", type: "supergroup" },
    from: input.from,
    messageId: input.messageId,
    raw: { date: 1_700_000_000 + Number(input.messageId) },
    text: "сообщение",
  };
}

async function recordInGroup(groupId: string, message: TelegramMessage): Promise<string> {
  const actor = telegramInboundActor(message);
  if (actor === null) throw new Error("AGENT_TEST_TELEGRAM_ACTOR_INVALID: Тестовое сообщение без автора");
  return (await telegramGroupJournalRepository.record(groupId, message, actor)).sequenceId;
}

async function setUp() {
  const family = await database().query<{ id: string }>("INSERT INTO families (name) VALUES ('Семья') RETURNING id");
  const owner = await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Владелец') RETURNING id",
    [OWNER_TELEGRAM_ID],
  );
  const familyId = family.rows[0]!.id;
  const ownerId = owner.rows[0]!.id;
  await database().query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [familyId, ownerId]);
  const register = (telegramChatId: string, title: string) => telegramGroupAdministrationRepository.registerGroup({
    familyId, messageMode: "all", requestedBy: ownerId, telegramChatId, title, toolAllowlist: [], type: "external",
  });
  const first = await register("-1001", "Первая группа");
  const second = await register("-1002", "Вторая группа");
  const groupAuth = (groupId: string): WorkspaceAuthorization => ({
    familyId, groupId, groupType: "external", role: "external", telegramChatType: "supergroup", userId: null,
  });
  return {
    first: groupAuth(first.groupId),
    firstGroupId: first.groupId,
    private: { familyId, groupId: null, groupType: null, role: "owner", telegramChatType: "private", userId: ownerId } as WorkspaceAuthorization,
    second: groupAuth(second.groupId),
    secondGroupId: second.groupId,
  };
}

describeWithDatabase("telegramAvatarAuthorRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE invitations, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("names the author of a message only inside the chat that holds it", async () => {
    const chats = await setUp();
    const anna = await recordInGroup(chats.firstGroupId, groupMessage({
      chatId: "-1001", from: { firstName: "Анна", id: "101", isBot: false, username: "anna" }, messageId: "1",
    }));
    const bot = await recordInGroup(chats.firstGroupId, groupMessage({
      chatId: "-1001", from: { firstName: "Мия", id: "202", isBot: true, username: "mia_bot" }, messageId: "2",
    }));
    const boris = await recordInGroup(chats.secondGroupId, groupMessage({
      chatId: "-1002", from: { firstName: "Борис", id: "303", isBot: false, username: "boris" }, messageId: "1",
    }));
    const privateConversation = await conversationRepository.getByChatId(OWNER_TELEGRAM_ID);
    const own = await conversationTimelineRepository.recordInbound(privateConversation.id, {
      attachments: [],
      caption: "",
      chat: { id: OWNER_TELEGRAM_ID, type: "private" },
      from: { firstName: "Владелец", id: OWNER_TELEGRAM_ID, isBot: false, username: "owner" },
      messageId: "10",
      raw: { date: 1_700_000_100 },
      text: "как я выгляжу?",
    });

    // Every chat numbers its own messages from the start, so one number exists in all three.
    expect(new Set([anna, boris, own.sequenceId]).size).toBe(1);
    await expect(telegramAvatarAuthorRepository.find(chats.first, anna)).resolves.toMatchObject({
      actorKind: "user", senderUsername: "anna", telegramUserId: "101",
    });
    await expect(telegramAvatarAuthorRepository.find(chats.second, boris)).resolves.toMatchObject({
      actorKind: "user", senderUsername: "boris", telegramUserId: "303",
    });
    await expect(telegramAvatarAuthorRepository.find(chats.private, own.sequenceId)).resolves.toMatchObject({
      actorKind: "user", telegramUserId: OWNER_TELEGRAM_ID,
    });
    await expect(telegramAvatarAuthorRepository.find(chats.first, bot)).resolves.toMatchObject({
      actorKind: "telegram_bot", senderUsername: "mia_bot", telegramUserId: "202",
    });
    // The bot's message exists only in the first group: the second group and the private chat do not see it.
    await expect(telegramAvatarAuthorRepository.find(chats.second, bot)).resolves.toBeNull();
    await expect(telegramAvatarAuthorRepository.find(chats.private, bot)).resolves.toBeNull();
  });
});
