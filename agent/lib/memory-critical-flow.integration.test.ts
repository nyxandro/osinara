/**
 * Critical main-agent memory path integration tests.
 *
 * Constructs covered:
 * - Step-scoped capability resolution returns Eve-branded `remember` and `load_skill` definitions.
 * - `bindMemoryTurnSources` freezes the current verified Telegram source for the Eve turn.
 * - The emitted `remember` tool persists one group claim, evidence, operation, audit, and index job.
 * - Turn completion releases the source binding, and subagents never receive `remember`.
 * - A durable background review writes from its exact batch source and retires cleanly.
 */
import type { ToolContext } from "eve/tools";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import capabilities from "../tools/capabilities.js";
import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review/memory-review-dispatch-repository.js";
import { memoryReviewRepository } from "./memory-review/memory-review-repository.js";
import { memoryReviewSessionRepository } from "./memory-review/memory-review-session-repository.js";
import {
  bindMemoryTurnSources,
  releaseMemoryTurnSources,
  resolveMemoryTurnSource,
} from "./memory-turn-source.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const EVE_TOOL_BRAND = Symbol.for("eve:tool-brand");

function sessionContext(input: {
  applicationSessionId: string;
  conversationId: string;
  familyId: string;
  groupId: string;
  timelineEntryId: string;
}) {
  const attributes = {
    applicationSessionId: input.applicationSessionId,
    familyId: input.familyId,
    groupId: input.groupId,
    groupType: "external",
    memoryScopes: ["group"],
    role: "external",
    telegramChatType: "supergroup",
    telegramConversationId: input.conversationId,
    telegramTimelineEntryId: input.timelineEntryId,
    telegramTimelineVisibleEntryIds: [input.timelineEntryId],
    telegramActorId: "external-memory-author",
    telegramActorKind: "telegram_user",
    telegramUserId: "external-memory-author",
    toolAllowlist: ["remember"],
  };
  const auth = {
    current: {
      attributes,
      authenticator: "telegram",
      principalId: "telegram:external-memory-author",
      principalType: "user",
    },
    initiator: null,
  };
  return {
    channel: { kind: "telegram" },
    messages: [],
    session: {
      auth,
      id: "eve-critical-memory-session",
      turn: { id: "eve-critical-memory-turn" },
    },
  };
}

function reviewContext(input: {
  applicationSessionId: string;
  batchId: string;
  conversationId: string;
  familyId: string;
  groupId: string;
  sourceEntryIds: string[];
  userId: string;
}) {
  return {
    channel: { kind: "memory-review" },
    messages: [],
    session: {
      auth: {
        current: {
          attributes: {
            applicationSessionId: input.applicationSessionId,
            familyId: input.familyId,
            groupId: input.groupId,
            groupType: "family_private",
            memoryReviewBatchId: input.batchId,
            memoryReviewMode: "background",
            memoryReviewSourceEntryIds: input.sourceEntryIds,
            memoryScopes: ["family"],
            role: "owner",
            telegramActorId: "agent-memory-author",
            telegramActorKind: "telegram_user",
            telegramChatType: "supergroup",
            telegramConversationId: input.conversationId,
            telegramUserId: "agent-memory-author",
          },
          authenticator: "memory-review",
          principalId: input.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "eve-background-memory-session",
      turn: { id: "eve-background-memory-turn" },
    },
  };
}

describeWithDatabase("critical main-agent memory paths", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("resolves, binds, writes, audits, and releases one source-backed memory", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Critical memory flow') RETURNING id",
    );
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups
         (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist, skill_allowlist)
       VALUES ($1, '-100-critical-memory', 'Critical memory', 'external', 'addressed_only',
               ARRAY['remember'], '{}')
       RETURNING id`,
      [family.rows[0]!.id],
    );
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
      [group.rows[0]!.id],
    );
    const participant = await database().query<{ id: string }>(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'group', $3, 'external-memory-author', 'Гость', now(), now())
       RETURNING id`,
      [conversation.rows[0]!.id, family.rows[0]!.id, group.rows[0]!.id],
    );
    const message = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 7001, 1, 'user', 'telegram:external-memory-author',
               'external-memory-author', 'Гость', false, 'text',
               'Запомни: проект использует синий корпус', now())
       RETURNING id`,
      [conversation.rows[0]!.id, group.rows[0]!.id],
    );
    const appSession = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'group', 'canonical', 'critical-memory',
               'critical-memory:0', now(), now())
       RETURNING id`,
      [family.rows[0]!.id, group.rows[0]!.id],
    );
    const context = sessionContext({
      applicationSessionId: appSession.rows[0]!.id,
      conversationId: conversation.rows[0]!.id,
      familyId: family.rows[0]!.id,
      groupId: group.rows[0]!.id,
      timelineEntryId: message.rows[0]!.id,
    });

    await bindMemoryTurnSources(context as never);
    const surface = await capabilities.events["step.started"]?.({} as never, context as never);
    expect(surface?.remember).toBeDefined();
    expect(surface?.load_skill).toBeDefined();
    expect((surface?.remember as unknown as Record<symbol, unknown>)[EVE_TOOL_BRAND]).toBe(true);
    expect((surface?.load_skill as unknown as Record<symbol, unknown>)[EVE_TOOL_BRAND]).toBe(true);

    const result = await surface!.remember!.execute({
      basis: "user_requested",
      content: "Проект использует синий корпус",
      kind: "fact",
      scope: "group",
      sensitivity: "normal",
      subject: { kind: "current_author" },
    }, {
      callId: "critical-memory-call",
      session: context.session,
    } as unknown as ToolContext);
    if (Symbol.asyncIterator in Object(result)) {
      throw new Error("AGENT_MEMORY_CRITICAL_FLOW_STREAM_UNEXPECTED: remember returned a stream");
    }
    expect(result).toMatchObject({
      item: {
        content: "Проект использует синий корпус",
        scope: "group",
      },
    });

    await expect(database().query(
      `SELECT item.content, item.group_id, item.subject_participant_id,
              evidence.timeline_entry_id, operation.eve_session_id, operation.eve_turn_id,
              audit.event_type,
              EXISTS (SELECT 1 FROM memory_embedding_jobs AS job
                      WHERE job.memory_item_id = item.id) AS embedding_job
         FROM memory_items AS item
         JOIN claim_evidence AS evidence ON evidence.claim_id = item.id
         JOIN memory_mutation_operations AS operation ON operation.memory_item_id = item.id
         JOIN audit_events AS audit ON audit.subject_id = item.id
        WHERE operation.operation_key = 'critical-memory-call'`,
    )).resolves.toMatchObject({ rows: [{
      content: "Проект использует синий корпус",
      embedding_job: true,
      eve_session_id: "eve-critical-memory-session",
      eve_turn_id: "eve-critical-memory-turn",
      event_type: "memory.created",
      group_id: group.rows[0]!.id,
      subject_participant_id: participant.rows[0]!.id,
      timeline_entry_id: message.rows[0]!.id,
    }] });

    const subagentSurface = await capabilities.events["step.started"]?.({} as never, {
      ...context,
      channel: { kind: "subagent" },
    } as never);
    expect(subagentSurface).not.toHaveProperty("remember");

    await releaseMemoryTurnSources(context as never);
    await expect(resolveMemoryTurnSource(context as never, {
      familyId: family.rows[0]!.id,
      groupId: group.rows[0]!.id,
      role: "external",
      scopes: ["group"],
      telegramActorId: "external-memory-author",
      telegramActorKind: "telegram_user",
      telegramUserId: "external-memory-author",
      userId: null,
    })).rejects.toMatchObject({ code: "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID" });
  });

  it("writes and terminalizes one durable background review batch", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const sourceEntryIds = [fixture.timelineEntryId];

    // Fifty passive messages cross the configured durable review boundary exactly once.
    for (let sequence = 2; sequence <= 51; sequence += 1) {
      const message = await database().query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
                 'agent-memory-author', 'Анна', false, 'text', $4, now()) RETURNING id`,
        [fixture.conversationId, fixture.groupId, sequence,
          sequence === 50 ? "Анна предпочитает утренние тренировки" : `Фоновое сообщение ${sequence}`],
      );
      sourceEntryIds.push(message.rows[0]!.id);
      await memoryReviewRepository.observePassiveMessage({
        groupId: fixture.groupId,
        timelineEntryId: message.rows[0]!.id,
      });
    }

    // Reproduce the durable dispatcher and channel turn-start boundaries before tool execution.
    const [batch] = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-13T10:00:00.000Z"),
    });
    expect(batch?.sourceEntryIds).toEqual(sourceEntryIds.slice(0, 50));
    const appSession = await memoryReviewSessionRepository.prepare(
      batch!,
      new Date("2026-08-13T10:00:01.000Z"),
    );
    expect(await memoryReviewDispatchRepository.markDispatchStarted(batch!, appSession.id)).toBe(true);
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: appSession.id,
      batchId: batch!.batchId,
      eveSessionId: "eve-background-memory-session",
      eveTurnId: "eve-background-memory-turn",
    });
    const context = reviewContext({
      applicationSessionId: appSession.id,
      batchId: batch!.batchId,
      conversationId: fixture.conversationId,
      familyId: fixture.familyId,
      groupId: fixture.groupId,
      sourceEntryIds: batch!.sourceEntryIds,
      userId: fixture.userId,
    });
    await bindMemoryTurnSources(context as never);

    // The review surface must execute the same source-backed writer used by ordinary main turns.
    const surface = await capabilities.events["step.started"]?.({} as never, context as never);
    expect((surface?.remember as unknown as Record<symbol, unknown>)[EVE_TOOL_BRAND]).toBe(true);
    const result = await surface!.remember!.execute({
      basis: "agent_inferred",
      content: "Анна предпочитает утренние тренировки",
      kind: "preference",
      scope: "family",
      sensitivity: "normal",
      sourceSequence: "50",
      subject: { kind: "source_author" },
    }, {
      callId: "background-memory-call",
      session: context.session,
    } as unknown as ToolContext);
    if (Symbol.asyncIterator in Object(result)) {
      throw new Error("AGENT_MEMORY_CRITICAL_FLOW_STREAM_UNEXPECTED: remember returned a stream");
    }

    // Successful lifecycle completion advances the lane and releases all temporary retention rows.
    await memoryReviewRepository.completeBatch({
      batchId: batch!.batchId,
      completedAt: new Date("2026-08-13T10:00:02.000Z"),
      eveSessionId: "eve-background-memory-session",
      eveTurnId: "eve-background-memory-turn",
    });
    await releaseMemoryTurnSources(context as never);
    await expect(database().query(
      `SELECT item.content, evidence.timeline_entry_id, batch.status::text AS batch_status,
              app_session.task_state::text AS task_state, app_session.retired_at,
              lane.processed_through_sequence::text AS lane_cursor,
              count(batch_source.timeline_entry_id)::integer AS retained_batch_sources,
              count(turn_source.timeline_entry_id)::integer AS retained_turn_sources
         FROM memory_items AS item
         JOIN claim_evidence AS evidence ON evidence.claim_id = item.id
         JOIN memory_mutation_operations AS operation ON operation.memory_item_id = item.id
         JOIN memory_review_batches AS batch ON batch.id = $1
         JOIN memory_review_lanes AS lane ON lane.id = batch.lane_id
         JOIN conversation_sessions AS app_session ON app_session.id = batch.application_session_id
         LEFT JOIN memory_review_batch_sources AS batch_source ON batch_source.batch_id = batch.id
         LEFT JOIN memory_turn_sources AS turn_source
           ON turn_source.eve_session_id = operation.eve_session_id
          AND turn_source.eve_turn_id = operation.eve_turn_id
        WHERE operation.operation_key = 'background-memory-call'
        GROUP BY item.id, item.content, evidence.timeline_entry_id, batch.status,
                 app_session.task_state, app_session.retired_at, lane.processed_through_sequence`,
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{
      batch_status: "completed",
      content: "Анна предпочитает утренние тренировки",
      lane_cursor: "50",
      retained_batch_sources: 0,
      retained_turn_sources: 0,
      retired_at: expect.any(Date),
      task_state: "completed",
      timeline_entry_id: sourceEntryIds[49],
    }] });
  });
});
