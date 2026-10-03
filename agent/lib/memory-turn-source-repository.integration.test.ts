/**
 * Durable turn-bound memory source PostgreSQL tests.
 *
 * Constructs covered:
 * - One immutable turn snapshot binds the current message and visible group delta.
 * - HITL resume verification accepts only the same application session, turn, and Telegram actor.
 * - Sequence resolution returns only a source captured for that exact agent session and turn.
 * - Rebinding the same turn with a different visible set fails instead of widening access.
 * - A bot-invoked turn binds against its own actor kind and Telegram id.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
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
      agentSessionId: "agent-source-session",
      agentTurnId: "agent-source-turn",
      invokingActorId: "agent-memory-author",
      invokingActorKind: "telegram_user" as const,
      visibleTimelineEntryIds: [delta.rows[0]!.id, fixture.timelineEntryId],
    };
    await memoryTurnSourceRepository.bind(binding);

    await expect(memoryTurnSourceRepository.verifyBoundResume({
      applicationSessionId: binding.applicationSessionId,
      agentSessionId: binding.agentSessionId,
      agentTurnId: binding.agentTurnId,
      invokingActorId: binding.invokingActorId,
      invokingActorKind: binding.invokingActorKind,
    })).resolves.toBe(true);
    await expect(memoryTurnSourceRepository.verifyBoundResume({
      applicationSessionId: binding.applicationSessionId,
      agentSessionId: binding.agentSessionId,
      agentTurnId: binding.agentTurnId,
      invokingActorId: "another-telegram-actor",
      invokingActorKind: binding.invokingActorKind,
    })).resolves.toBe(false);

    await expect(memoryTurnSourceRepository.resolve({
      agentSessionId: binding.agentSessionId,
      agentTurnId: binding.agentTurnId,
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
      provenance: { sessionId: binding.agentSessionId, turnId: binding.agentTurnId },
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
      agentSessionId: binding.agentSessionId,
      agentTurnId: binding.agentTurnId,
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

    await memoryTurnSourceRepository.release(binding.agentSessionId, binding.agentTurnId);
    await expect(memoryTurnSourceRepository.resolve({
      agentSessionId: binding.agentSessionId,
      agentTurnId: binding.agentTurnId,
      sourceSequence: "2",
    })).resolves.toBeNull();
  });

  it("binds a turn invoked by another bot to that bot's own identity", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const botEntry = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 903, 3, 'telegram_bot', 'telegram-bot:8123456789', '8123456789',
               'Мия', true, 'text', 'Осинара, привет', now())
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
      currentTimelineEntryId: botEntry.rows[0]!.id,
      agentSessionId: "agent-bot-session",
      agentTurnId: "agent-bot-turn",
      invokingActorId: "8123456789",
      invokingActorKind: "telegram_bot" as const,
      visibleTimelineEntryIds: [botEntry.rows[0]!.id],
    };

    await expect(memoryTurnSourceRepository.bind(binding)).resolves.not.toThrow();

    await expect(memoryTurnSourceRepository.verifyBoundResume({
      applicationSessionId: binding.applicationSessionId,
      agentSessionId: binding.agentSessionId,
      agentTurnId: binding.agentTurnId,
      invokingActorId: binding.invokingActorId,
      invokingActorKind: binding.invokingActorKind,
    })).resolves.toBe(true);

    // A bot must not be able to bind a turn against a channel-shaped or human identity.
    await expect(memoryTurnSourceRepository.bind({
      ...binding,
      agentTurnId: "agent-bot-turn-forged",
      invokingActorKind: "telegram_channel" as const,
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_TURN_SOURCE_SET_INVALID" });
  });
});
