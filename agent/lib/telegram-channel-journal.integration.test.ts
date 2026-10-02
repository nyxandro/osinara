/**
 * Telegram channel actor timeline integration tests.
 *
 * Constructs covered:
 * - Channel identity is persisted separately from Telegram user identity and Channel_Bot.
 * - Timeline reads preserve channel attribution for model context.
 * - Channel actors never materialize as human conversation participants.
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

function channelMessage(): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1003576522523", title: "Остриков пилит агентов", type: "supergroup" },
    from: { firstName: "Channel", id: "136817688", isBot: true, username: "Channel_Bot" },
    messageId: "54068",
    raw: {
      date: 1_787_000_000,
      from: { first_name: "Channel", id: 136_817_688, is_bot: true, username: "Channel_Bot" },
      sender_chat: {
        id: -1_001_783_384_254,
        title: "Pavel Zloi",
        type: "channel",
        username: "evilfreelancer",
      },
    },
    text: "@osinara_bot ты меня видишь?",
  };
}

describeWithDatabase("Telegram channel journal", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE telegram_group_messages, telegram_groups,
         family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("persists channel provenance without creating a human participant", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Channel timeline') RETURNING id",
    );
    const owner = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('channel-owner', 'Владелец') RETURNING id`,
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, owner.rows[0]!.id],
    );
    const group = await telegramGroupAdministrationRepository.registerGroup({
      familyId: family.rows[0]!.id,
      messageMode: "addressed_only",
      requestedBy: owner.rows[0]!.id,
      telegramChatId: "-1003576522523",
      title: "Остриков пилит агентов",
      toolAllowlist: [],
      type: "external",
    });
    const message = channelMessage();
    const actor = telegramInboundActor(message)!;

    const recorded = await telegramGroupJournalRepository.record(group.groupId, message, actor);

    await expect(database().query(
      `SELECT actor_kind, actor_id, telegram_user_id, telegram_sender_chat_id,
              sender_username, sender_display_name, sender_is_bot
         FROM telegram_group_messages WHERE id = $1`,
      [recorded.entryId],
    )).resolves.toMatchObject({ rows: [{
      actor_id: "telegram-channel:-1001783384254",
      actor_kind: "telegram_channel",
      sender_display_name: "Pavel Zloi",
      sender_is_bot: false,
      sender_username: "evilfreelancer",
      telegram_sender_chat_id: "-1001783384254",
      telegram_user_id: null,
    }] });
    const entries = await telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: group.groupId,
      limit: 10,
      messageThreadId: null,
    });
    expect(entries).toMatchObject([{ actorKind: "telegram_channel" }]);

    const conversation = await conversationRepository.getByGroupId(group.groupId);
    await expect(
      conversationRepository.syncTimelineParticipants(conversation.id, [recorded.entryId]),
    ).resolves.toEqual([]);
    await expect(database().query(
      "SELECT count(*)::integer AS count FROM conversation_participants WHERE conversation_id = $1",
      [conversation.id],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
