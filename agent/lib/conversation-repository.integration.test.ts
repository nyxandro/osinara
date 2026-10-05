/**
 * Stable application conversation and participant repository integration tests.
 *
 * Constructs covered:
 * - Group chat lookup returns one stable conversation independent of forum topic metadata.
 * - Participant synchronization trusts Telegram user IDs and exact user links, never usernames.
 * - Opaque participant refs remain local to their origin conversation.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conversationRepository } from "./conversation-repository.js";
import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("conversationRepository", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE claim_evidence, memory_items_all,
         telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
    );
  });

  afterAll(closeDatabase);

  it("synchronizes verified group-local participants without username identity", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Conversation test') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name, telegram_username)
       VALUES ('501', 'Связанная Анна', 'same_name') RETURNING id`,
    );
    const groups = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100501', 'Первая группа', 'external', 'addressed_only'),
              ($1, '-100502', 'Вторая группа', 'external', 'addressed_only')
       RETURNING id`,
      [family.rows[0]!.id],
    );
    const entries = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_username, sender_display_name, sender_is_bot,
          message_kind, content_text, sent_at)
       VALUES ($1, 1, 1, 'user', 'telegram:501', '501', 'same_name', 'Анна', false,
               'text', 'Первое сообщение', now()),
              ($1, 2, 2, 'user', 'telegram:777', '777', 'same_name', 'Другая Анна', false,
               'text', 'Второе сообщение', now()),
              ($1, 3, 3, 'user', 'telegram:501', '501', 'changed_name', 'Анна Новая', false,
               'text', 'Сообщение в теме', now())
       RETURNING id`,
      [groups.rows[0]!.id],
    );

    const conversation = await conversationRepository.getByGroupId(groups.rows[0]!.id);
    const participants = await conversationRepository.syncTimelineParticipants(
      conversation.id,
      entries.rows.map((row) => row.id),
    );

    expect(conversation.scope).toBe("group");
    expect(participants).toHaveLength(2);
    expect(participants.find((item) => item.telegramUserId === "501")).toMatchObject({
      displayNameSnapshot: "Анна Новая",
      linkedUserId: user.rows[0]!.id,
    });
    expect(participants.find((item) => item.telegramUserId === "777")).toMatchObject({
      linkedUserId: null,
    });

    const firstRef = participants[0]!.participantRef;
    const otherConversation = await conversationRepository.getByGroupId(groups.rows[1]!.id);
    await expect(
      conversationRepository.resolveParticipantRef(otherConversation.id, firstRef),
    ).rejects.toThrowError(/AGENT_CONVERSATION_PARTICIPANT_NOT_FOUND/u);
  });
});
