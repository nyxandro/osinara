/**
 * Telegram bot participant timeline integration tests.
 *
 * Constructs covered:
 * - A bot participant is persisted under its own Telegram identity, marked as a bot.
 * - Timeline reads preserve bot attribution for model context.
 * - A bot becomes a conversation participant like a person, without an application account link.
 * - The schema rejects a bot row that claims a human-shaped identity.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { conversationRepository } from "./conversation-repository.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";
import { telegramGroupJournalRepository } from "./telegram-group-journal-repository.js";
import { telegramInboundActor } from "./telegram-inbound-actor.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

// Timeline integration tests mutate shared tables and therefore require an isolated test database.
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

function botMessage(): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-5306107028", title: "BotBattle", type: "group" },
    from: { firstName: "Мия", id: "8123456789", isBot: true, username: "mimimia_ai_bot" },
    messageId: "412",
    raw: {
      date: 1_787_000_000,
      from: { first_name: "Мия", id: 8_123_456_789, is_bot: true, username: "mimimia_ai_bot" },
    },
    text: "@osinara_bot привет, как дела?",
  };
}

async function externalGroup(): Promise<{ groupId: string }> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Bot timeline') RETURNING id",
  );
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ('bot-timeline-owner', 'Владелец') RETURNING id`,
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [family.rows[0]!.id, owner.rows[0]!.id],
  );
  return telegramGroupAdministrationRepository.registerGroup({
    familyId: family.rows[0]!.id,
    messageMode: "all",
    requestedBy: owner.rows[0]!.id,
    telegramChatId: "-5306107028",
    title: "BotBattle",
    toolAllowlist: [],
    type: "external",
  });
}

describeWithDatabase("Telegram bot journal", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_group_messages, telegram_groups,
         family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("persists bot provenance and admits the bot as a participant", async () => {
    const group = await externalGroup();
    const message = botMessage();
    const actor = telegramInboundActor(message)!;

    const recorded = await telegramGroupJournalRepository.record(group.groupId, message, actor);

    await expect(database().query(
      `SELECT actor_kind, actor_id, telegram_user_id, telegram_sender_chat_id,
              sender_username, sender_display_name, sender_is_bot
         FROM telegram_group_messages WHERE id = $1`,
      [recorded.entryId],
    )).resolves.toMatchObject({ rows: [{
      actor_id: "telegram-bot:8123456789",
      actor_kind: "telegram_bot",
      sender_display_name: "Мия",
      sender_is_bot: true,
      sender_username: "mimimia_ai_bot",
      telegram_sender_chat_id: null,
      telegram_user_id: "8123456789",
    }] });
    const entries = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: group.groupId,
      limit: 10,
      messageThreadId: null,
    });
    expect(entries).toMatchObject([{ actorKind: "telegram_bot", senderIsBot: true }]);

    // A bot joins the conversation under its own Telegram id and links to no `users` row, exactly
    // like a person in a public group who never enrolled.
    const conversation = await conversationRepository.getByGroupId(group.groupId);
    await conversationRepository.syncTimelineParticipants(conversation.id, [recorded.entryId]);
    await expect(database().query(
      `SELECT telegram_user_id, display_name_snapshot, linked_user_id
         FROM conversation_participants WHERE conversation_id = $1`,
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{
      display_name_snapshot: "Мия",
      linked_user_id: null,
      telegram_user_id: "8123456789",
    }] });
  });

  it("rejects a bot row that hides its bot identity", async () => {
    const group = await externalGroup();
    const conversation = await conversationRepository.getByGroupId(group.groupId);

    await expect(database().query(
      `INSERT INTO telegram_group_messages
         (group_id, conversation_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          telegram_user_id, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 1, 'telegram_bot', 'telegram-bot:8123456789', 412,
          '8123456789', false, 'text', 'подделка', now())`,
      [group.groupId, conversation.id],
    )).rejects.toThrow(/telegram_group_messages_bot_actor_shape/u);
  });
});
