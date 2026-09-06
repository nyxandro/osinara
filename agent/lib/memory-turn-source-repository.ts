/**
 * Durable PostgreSQL boundary for one immutable turn-visible memory source set.
 *
 * Exports:
 * - `BindMemoryTurnSourcesInput`: verified Telegram and Eve turn coordinates.
 * - `ResolvedMemoryTurnSource`: exact source and authorization partition projection.
 * - `memoryTurnSourceRepository`: replay-safe binding, HITL resume verification, and source resolution.
 */
import { createHash } from "node:crypto";

import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { TelegramActorKind, TelegramTimelineActorKind } from "./telegram-inbound-actor.js";

export interface BindMemoryTurnSourcesInput {
  applicationSessionId: string;
  conversationId: string;
  currentTimelineEntryId: string;
  eveSessionId: string;
  eveTurnId: string;
  invokingActorId: string;
  invokingActorKind: TelegramActorKind;
  memoryReviewBatchId?: string;
  memoryReviewSourceEntryIds?: readonly string[];
  visibleTimelineEntryIds: readonly string[];
}

export interface ResolvedMemoryTurnSource {
  conversationId: string;
  invokingActorId: string;
  invokingActorKind: TelegramActorKind;
  isCurrent: boolean;
  isReview: boolean;
  messageThreadId: string | null;
  scope: "family" | "group" | "personal";
  scopePartitionKey: string;
  sourceMessageId: string;
  timelineEntryId: string;
}

interface SourceRow {
  conversation_id: string;
  invoking_actor_id: string;
  invoking_actor_kind: TelegramActorKind;
  is_current: boolean;
  is_review: boolean;
  message_thread_id: string | null;
  scope: ResolvedMemoryTurnSource["scope"];
  scope_partition_key: string;
  source_message_id: string;
  timeline_entry_id: string;
}

function canonicalEntryIds(input: BindMemoryTurnSourcesInput): string[] {
  const reviewIds = input.memoryReviewSourceEntryIds ?? [];
  if (new Set(input.visibleTimelineEntryIds).size !== input.visibleTimelineEntryIds.length || new Set(reviewIds).size !== reviewIds.length) {
    throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Набор сообщений текущего хода содержит повторяющиеся источники");
  }
  const combined = [...input.visibleTimelineEntryIds, ...reviewIds];
  const unique = [...new Set(combined)];
  if (unique.length === 0 || !unique.includes(input.currentTimelineEntryId)) {
    throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Не удалось подтвердить набор сообщений текущего хода");
  }
  return unique.sort();
}

function bindingHash(input: BindMemoryTurnSourcesInput, entryIds: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        applicationSessionId: input.applicationSessionId,
        conversationId: input.conversationId,
        currentTimelineEntryId: input.currentTimelineEntryId,
        eveSessionId: input.eveSessionId,
        eveTurnId: input.eveTurnId,
        invokingActorId: input.invokingActorId,
        invokingActorKind: input.invokingActorKind,
        memoryReviewBatchId: input.memoryReviewBatchId ?? null,
        visibleTimelineEntryIds: entryIds,
      }),
    )
    .digest("hex");
}

export const memoryTurnSourceRepository = {
  async verifyBoundResume(input: { applicationSessionId: string; eveSessionId: string; eveTurnId: string; invokingActorId: string; invokingActorKind: TelegramActorKind }): Promise<boolean> {
    // HITL resumes omit the original message attributes, so only the exact retained source-set may
    // authorize the same durable turn and actor to continue.
    const result = await database().query<{ matches: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM memory_turn_source_sets
          WHERE eve_session_id = $1 AND eve_turn_id = $2
            AND application_session_id = $3
            AND invoking_actor_id = $4 AND invoking_actor_kind = $5
       ) AS matches`,
      [input.eveSessionId, input.eveTurnId, input.applicationSessionId, input.invokingActorId, input.invokingActorKind],
    );
    return result.rows[0]?.matches === true;
  },

  async bind(input: BindMemoryTurnSourcesInput): Promise<void> {
    const entryIds = canonicalEntryIds(input);
    const hash = bindingHash(input, entryIds);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ binding_hash: string }>(
        `SELECT binding_hash FROM memory_turn_source_sets
         WHERE eve_session_id = $1 AND eve_turn_id = $2 FOR UPDATE`,
        [input.eveSessionId, input.eveTurnId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].binding_hash !== hash) {
          throw new AppError("AGENT_MEMORY_TURN_SOURCE_REPLAY_MISMATCH", "Повторная привязка источников хода не совпадает с исходной");
        }
        await client.query("COMMIT");
        return;
      }

      // The application session and stable conversation must describe one exact trust-zone axis.
      const boundary = await client.query(
        `SELECT 1
         FROM conversation_sessions AS app_session
         JOIN application_conversations AS conversation
           ON conversation.id = $2
          AND conversation.family_id = app_session.family_id
          AND conversation.scope = app_session.scope
          AND (
            (conversation.scope = 'personal'
              AND conversation.owner_user_id = app_session.owner_user_id
              AND app_session.group_id IS NULL) OR
            (conversation.scope IN ('family', 'group')
              AND conversation.telegram_group_id = app_session.group_id
              AND app_session.owner_user_id IS NULL)
          )
         WHERE app_session.id = $1 AND app_session.retired_at IS NULL
           AND app_session.kind IN ('canonical', 'task')`,
        [input.applicationSessionId, input.conversationId],
      );
      if (!boundary.rowCount) {
        throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Контекст хода не соответствует проверенному разговору");
      }

      // The full set is verified in one query before any binding row becomes durable.
      const entries = await client.query<{
        actor_kind: TelegramTimelineActorKind;
        id: string;
        sequence_id: string;
        telegram_sender_chat_id: string | null;
        telegram_user_id: string | null;
      }>(
        `SELECT id, sequence_id::text, actor_kind, telegram_user_id, telegram_sender_chat_id
         FROM telegram_group_messages
         WHERE conversation_id = $1 AND id = ANY($2::uuid[])
         ORDER BY sequence_id`,
        [input.conversationId, entryIds],
      );
      const current = entries.rows.find((entry) => entry.id === input.currentTimelineEntryId);
      // A user and another bot are both identified by telegram_user_id; only a channel post
      // carries its identity in sender_chat.
      const currentActorId = input.invokingActorKind === "telegram_channel"
        ? current?.telegram_sender_chat_id
        : current?.telegram_user_id;
      const expectedActorKind = input.invokingActorKind === "telegram_user"
        ? "user"
        : input.invokingActorKind;
      if (entries.rows.length !== entryIds.length || current?.actor_kind !== expectedActorKind || currentActorId !== input.invokingActorId) {
        throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Сообщения текущего хода не принадлежат проверенному разговору или автору");
      }
      if (input.memoryReviewBatchId !== undefined) {
        const review = await client.query<{ timeline_entry_id: string }>(
          `SELECT timeline_entry_id FROM memory_review_batch_sources
            WHERE batch_id = $1 AND conversation_id = $2 ORDER BY timeline_sequence`,
          [input.memoryReviewBatchId, input.conversationId],
        );
        const expected = [...(input.memoryReviewSourceEntryIds ?? [])].sort();
        if (
          expected.length === 0 ||
          review.rows.length !== expected.length ||
          review.rows
            .map((row) => row.timeline_entry_id)
            .sort()
            .some((entryId, index) => entryId !== expected[index])
        ) {
          throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Источники обычного хода не совпадают с пакетом проверки памяти");
        }
      }
      await client.query(
        `INSERT INTO memory_turn_source_sets
           (eve_session_id, eve_turn_id, application_session_id, conversation_id,
              current_timeline_entry_id, invoking_actor_kind, invoking_actor_id, binding_hash,
              memory_review_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [input.eveSessionId, input.eveTurnId, input.applicationSessionId, input.conversationId, input.currentTimelineEntryId, input.invokingActorKind, input.invokingActorId, hash, input.memoryReviewBatchId ?? null],
      );
      for (const entry of entries.rows) {
        await client.query(
          `INSERT INTO memory_turn_sources
             (eve_session_id, eve_turn_id, conversation_id, timeline_entry_id,
              timeline_sequence, is_current)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.eveSessionId, input.eveTurnId, input.conversationId, entry.id, entry.sequence_id, entry.id === input.currentTimelineEntryId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async bindReview(input: {
    applicationSessionId: string;
    conversationId: string;
    eveSessionId: string;
    eveTurnId: string;
    invokingActorId: string;
    invokingActorKind: TelegramActorKind;
    memoryReviewBatchId: string;
    sourceEntryIds: readonly string[];
  }): Promise<void> {
    const entryIds = [...new Set(input.sourceEntryIds)].sort();
    if (entryIds.length !== input.sourceEntryIds.length || entryIds.length === 0) {
      throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Не удалось подтвердить набор сообщений проверки памяти");
    }
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          ...input,
          sourceEntryIds: entryIds,
        }),
      )
      .digest("hex");
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ binding_hash: string }>(
        `SELECT binding_hash FROM memory_turn_source_sets
          WHERE eve_session_id = $1 AND eve_turn_id = $2 FOR UPDATE`,
        [input.eveSessionId, input.eveTurnId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].binding_hash !== hash) throw new AppError("AGENT_MEMORY_TURN_SOURCE_REPLAY_MISMATCH", "Повторная привязка источников проверки не совпадает с исходной");
        await client.query("COMMIT");
        return;
      }
      const boundary = await client.query(
        `SELECT 1
           FROM memory_review_batches AS batch
           JOIN conversation_sessions AS app_session
             ON app_session.id = $2 AND app_session.memory_review_batch_id = batch.id
            AND app_session.retired_at IS NULL AND app_session.kind = 'proactive'
           WHERE batch.id = $1 AND batch.conversation_id = $3 AND batch.status = 'running'
             AND batch.application_session_id = app_session.id`,
        [input.memoryReviewBatchId, input.applicationSessionId, input.conversationId],
      );
      if (!boundary.rowCount) throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Проверка памяти не соответствует текущему контексту");
      const entries = await client.query<{ id: string; sequence_id: string }>(
        `SELECT message.id, message.sequence_id::text
           FROM memory_review_batch_sources AS source
           JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
          WHERE source.batch_id = $1 AND source.conversation_id = $2
            AND message.id = ANY($3::uuid[]) AND message.actor_kind IN ('user', 'telegram_bot')
          ORDER BY message.sequence_id`,
        [input.memoryReviewBatchId, input.conversationId, entryIds],
      );
      if (entries.rows.length !== entryIds.length) throw new AppError("AGENT_MEMORY_TURN_SOURCE_SET_INVALID", "Источники проверки памяти не совпадают с пакетным снимком");
      await client.query(
        `INSERT INTO memory_turn_source_sets
           (eve_session_id, eve_turn_id, application_session_id, conversation_id,
             current_timeline_entry_id, invoking_actor_kind, invoking_actor_id, binding_hash,
             memory_review_batch_id)
          VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)`,
        [input.eveSessionId, input.eveTurnId, input.applicationSessionId, input.conversationId, input.invokingActorKind, input.invokingActorId, hash, input.memoryReviewBatchId],
      );
      for (const entry of entries.rows) {
        await client.query(
          `INSERT INTO memory_turn_sources
             (eve_session_id, eve_turn_id, conversation_id, timeline_entry_id,
              timeline_sequence, is_current)
           VALUES ($1, $2, $3, $4, $5, false)`,
          [input.eveSessionId, input.eveTurnId, input.conversationId, entry.id, entry.sequence_id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async resolve(input: { eveSessionId: string; eveTurnId: string; sourceSequence: string | null }): Promise<ResolvedMemoryTurnSource | null> {
    const result = await database().query<SourceRow>(
      `SELECT source.conversation_id, source.timeline_entry_id, source.is_current,
              (review_batch.batch_kind = 'background') AS is_review,
               source_set.invoking_actor_kind, source_set.invoking_actor_id,
               conversation.scope::text,
              conversation.scope_partition_key::text,
              message.telegram_message_id::text AS source_message_id,
              message.message_thread_id::text
       FROM memory_turn_sources AS source
       JOIN memory_turn_source_sets AS source_set
         ON source_set.eve_session_id = source.eve_session_id
        AND source_set.eve_turn_id = source.eve_turn_id
        JOIN application_conversations AS conversation ON conversation.id = source.conversation_id
        LEFT JOIN memory_review_batches AS review_batch
          ON review_batch.id = source_set.memory_review_batch_id
       JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
       WHERE source.eve_session_id = $1 AND source.eve_turn_id = $2
         AND message.actor_kind IN ('user', 'telegram_bot') AND message.content_text IS NOT NULL
         AND (($3::bigint IS NULL AND source.is_current) OR source.timeline_sequence = $3::bigint)`,
      [input.eveSessionId, input.eveTurnId, input.sourceSequence],
    );
    const row = result.rows[0];
    return row
      ? {
          conversationId: row.conversation_id,
          invokingActorId: row.invoking_actor_id,
          invokingActorKind: row.invoking_actor_kind,
          isCurrent: row.is_current,
          isReview: row.is_review,
          messageThreadId: row.message_thread_id,
          scope: row.scope,
          scopePartitionKey: row.scope_partition_key,
          sourceMessageId: row.source_message_id,
          timelineEntryId: row.timeline_entry_id,
        }
      : null;
  },

  async release(eveSessionId: string, eveTurnId: string): Promise<void> {
    await database().query(
      `DELETE FROM memory_turn_source_sets
       WHERE eve_session_id = $1 AND eve_turn_id = $2`,
      [eveSessionId, eveTurnId],
    );
  },
};
