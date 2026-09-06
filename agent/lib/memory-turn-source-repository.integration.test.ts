/**
 * Durable turn-bound memory source PostgreSQL tests.
 *
 * Constructs covered:
 * - One immutable Eve turn snapshot binds the current message and visible group delta.
 * - HITL resume verification accepts only the same application session, turn, and Telegram actor.
 * - Sequence resolution returns only a source captured for that exact Eve session and turn.
 * - Rebinding the same turn with a different visible set fails instead of widening access.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";
import { memoryTurnSourceRepository } from "./memory-turn-source-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("turn-bound memory source repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("lets a turn started by another bot save that bot's message as memory of the external group", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Bot memory') RETURNING id",
    );
    const familyId = family.rows[0]!.id;
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
       VALUES ($1, '-100-bot-memory', 'BotBattle', 'external', 'all', ARRAY['remember']::text[]) RETURNING id`,
      [familyId],
    );
    const groupId = group.rows[0]!.id;
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
      [groupId],
    );
    const conversationId = conversation.rows[0]!.id;
    await database().query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'group', $3, '7000000001', NULL, 'Osinara', now(), now())`,
      [conversationId, familyId, groupId],
    );
    const botMessage = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 1, 1, 'telegram_bot', 'telegram-bot:7000000001', '7000000001',
               'Osinara', true, 'text', 'Я предпочитаю работать в группе, а не один на один', now())
       RETURNING id`,
      [conversationId, groupId],
    );
    const appSession = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'group', 'canonical', 'bot-memory-source',
               'bot-memory-source:0', now(), now()) RETURNING id`,
      [familyId, groupId],
    );
    await memoryTurnSourceRepository.bind({
      applicationSessionId: appSession.rows[0]!.id,
      conversationId,
      currentTimelineEntryId: botMessage.rows[0]!.id,
      eveSessionId: "eve-bot-memory-session",
      eveTurnId: "eve-bot-memory-turn",
      invokingActorId: "7000000001",
      invokingActorKind: "telegram_bot",
      visibleTimelineEntryIds: [botMessage.rows[0]!.id],
    });

    // The same authorization a turn started by another bot carries in an external group.
    const botAuth: MemoryAuthorization = {
      familyId,
      groupId,
      role: "external",
      scopes: ["group"],
      telegramActorId: "7000000001",
      telegramActorKind: "telegram_bot",
      telegramUserId: null,
      userId: null,
    };
    const saved = await memoryRepository.create(botAuth, {
      confirmation: "model_high",
      content: "Осинара предпочитает работать в группе, а не один на один",
      explicitSource: {
        conversationId,
        subject: { kind: "label", label: "Осинара" },
        timelineEntryId: botMessage.rows[0]!.id,
      },
      kind: "preference",
      operationKey: "op-bot-memory-1",
      provenance: { sessionId: "eve-bot-memory-session", turnId: "eve-bot-memory-turn" },
      scope: "group",
      sensitivity: "normal",
      source: "eve:eve-bot-memory-session:eve-bot-memory-turn",
    });
    expect(saved.scope).toBe("group");
    expect(saved.kind).toBe("preference");
  });

  it("binds a turn started by another bot to its exact bot message", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const botMessage = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 903, 2, 'telegram_bot', 'telegram-bot:7000000001', '7000000001',
               'Другой бот', true, 'text', 'Привет, Мия', now())
       RETURNING id`,
      [fixture.conversationId, fixture.groupId],
    );
    const appSession = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'bot-turn-source',
               'bot-turn-source:0', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    const binding = {
      applicationSessionId: appSession.rows[0]!.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: botMessage.rows[0]!.id,
      eveSessionId: "eve-bot-source-session",
      eveTurnId: "eve-bot-source-turn",
      invokingActorId: "7000000001",
      invokingActorKind: "telegram_bot" as const,
      visibleTimelineEntryIds: [fixture.timelineEntryId, botMessage.rows[0]!.id],
    };

    // The bot id must match the message author; a user identity cannot claim a bot message.
    await expect(memoryTurnSourceRepository.bind({ ...binding, invokingActorId: "7000000002" }))
      .rejects.toThrowError(/AGENT_MEMORY_TURN_SOURCE_SET_INVALID/u);
    await expect(memoryTurnSourceRepository.bind({
      ...binding,
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
    })).rejects.toThrowError(/AGENT_MEMORY_TURN_SOURCE_SET_INVALID/u);

    await memoryTurnSourceRepository.bind(binding);
    await expect(memoryTurnSourceRepository.resolve({
      eveSessionId: binding.eveSessionId,
      eveTurnId: binding.eveTurnId,
      sourceSequence: null,
    })).resolves.toMatchObject({
      conversationId: fixture.conversationId,
      invokingActorId: "7000000001",
      invokingActorKind: "telegram_bot",
      isCurrent: true,
      timelineEntryId: botMessage.rows[0]!.id,
    });
  });

  it("binds and resolves only the immutable visible source set", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const secondUser = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('delta-author', 'Борис') RETURNING id",
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'member')",
      [fixture.familyId, secondUser.rows[0]!.id],
    );
    const delta = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 902, 2, 'user', 'telegram:delta-author', 'delta-author',
               'Борис', false, 'text', 'Начинаю долгий проект по судовому интернету', now())
       RETURNING id`,
      [fixture.conversationId, fixture.groupId],
    );
    await database().query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'family', $2, 'delta-author', $3, 'Борис', now(), now())`,
      [fixture.conversationId, fixture.familyId, secondUser.rows[0]!.id],
    );
    const appSession = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'turn-source',
               'turn-source:0', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );

    const binding = {
      applicationSessionId: appSession.rows[0]!.id,
      conversationId: fixture.conversationId,
      currentTimelineEntryId: fixture.timelineEntryId,
      eveSessionId: "eve-source-session",
      eveTurnId: "eve-source-turn",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user" as const,
      visibleTimelineEntryIds: [delta.rows[0]!.id, fixture.timelineEntryId],
    };
    await memoryTurnSourceRepository.bind(binding);

    await expect(memoryTurnSourceRepository.verifyBoundResume({
      applicationSessionId: binding.applicationSessionId,
      eveSessionId: binding.eveSessionId,
      eveTurnId: binding.eveTurnId,
      invokingActorId: binding.invokingActorId,
      invokingActorKind: binding.invokingActorKind,
    })).resolves.toBe(true);
    await expect(memoryTurnSourceRepository.verifyBoundResume({
      applicationSessionId: binding.applicationSessionId,
      eveSessionId: binding.eveSessionId,
      eveTurnId: binding.eveTurnId,
      invokingActorId: "another-telegram-actor",
      invokingActorKind: binding.invokingActorKind,
    })).resolves.toBe(false);

    await expect(memoryTurnSourceRepository.resolve({
      eveSessionId: binding.eveSessionId,
      eveTurnId: binding.eveTurnId,
      sourceSequence: "2",
    })).resolves.toMatchObject({
      conversationId: fixture.conversationId,
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user",
      isCurrent: false,
      scope: "family",
      timelineEntryId: delta.rows[0]!.id,
    });
    const memory = await memoryRepository.create(fixture.auth, {
      confirmation: "model_high",
      content: "Борис начал долгий проект по судовому интернету",
      explicitSource: {
        conversationId: fixture.conversationId,
        subject: { kind: "current_author" },
        timelineEntryId: delta.rows[0]!.id,
      },
      kind: "episode",
      operationKey: "delta-source-memory",
      provenance: { sessionId: binding.eveSessionId, turnId: binding.eveTurnId },
      scope: "family",
      sensitivity: "normal",
      source: "eve:delta-source-memory",
    });
    await expect(database().query(
      `SELECT item.subject_user_id, evidence.author_user_id, evidence.timeline_entry_id,
              operation.actor_user_id
       FROM memory_items AS item
       JOIN claim_evidence AS evidence ON evidence.claim_id = item.id
       JOIN memory_mutation_operations AS operation ON operation.memory_item_id = item.id
       WHERE item.id = $1`,
      [memory.id],
    )).resolves.toMatchObject({ rows: [{
      actor_user_id: fixture.userId,
      author_user_id: secondUser.rows[0]!.id,
      subject_user_id: secondUser.rows[0]!.id,
      timeline_entry_id: delta.rows[0]!.id,
    }] });
    await expect(memoryTurnSourceRepository.resolve({
      eveSessionId: binding.eveSessionId,
      eveTurnId: binding.eveTurnId,
      sourceSequence: null,
    })).resolves.toMatchObject({
      isCurrent: true,
      timelineEntryId: fixture.timelineEntryId,
    });

    await expect(memoryTurnSourceRepository.bind({
      ...binding,
      visibleTimelineEntryIds: [fixture.timelineEntryId],
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_TURN_SOURCE_REPLAY_MISMATCH" });

    // Active turn bindings retain source rows across ordinary timeline pruning/deletion attempts.
    await expect(database().query(
      "DELETE FROM telegram_group_messages WHERE id = $1",
      [delta.rows[0]!.id],
    )).rejects.toThrow();

    await memoryTurnSourceRepository.release(binding.eveSessionId, binding.eveTurnId);
    await expect(memoryTurnSourceRepository.resolve({
      eveSessionId: binding.eveSessionId,
      eveTurnId: binding.eveTurnId,
      sourceSequence: "2",
    })).resolves.toBeNull();
  });
});
