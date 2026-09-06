/**
 * PostgreSQL dispatch state for silent memory-review batches.
 *
 * Export:
 * - `memoryReviewDispatchRepository`: leasing and exact pre/post Eve handoff transitions.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { PoolClient } from "pg";
import type { TelegramGroupJournalEntry } from "../telegram-group-journal-context.js";
import {
  MEMORY_REVIEW_BATCH_SIZE,
  MEMORY_REVIEW_CONTEXT_LIMIT,
  MEMORY_REVIEW_IDLE_MILLISECONDS,
  MEMORY_REVIEW_IDLE_MIN_BATCH_SOURCES,
  MEMORY_REVIEW_IDLE_MIN_SOURCES,
  MEMORY_REVIEW_LONG_IDLE_MILLISECONDS,
  MEMORY_REVIEW_PRECEDING_CONTEXT_LIMIT,
} from "./memory-review-config.js";
import {
  memoryReviewDispatchTerminalRepository,
  terminalizeStaleMemoryReviewBatches,
} from "./memory-review-dispatch-terminal-repository.js";
import {
  formatExistingMemoryForReview,
  formatMemoryReviewBatchPrompt,
  formatPrecedingContextForReview,
  type ReviewMemoryContextItem,
} from "./memory-review-prompt.js";
import type { MemoryReviewClaim } from "./memory-review-repository.js";

interface SourceRow {
  actor_id: string;
  actor_kind: "agent_self" | "telegram_bot" | "user";
  content_text: string | null;
  id: string;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sender_username: string | null;
  sent_at: Date;
  sequence_id: string;
  telegram_user_id: string | null;
}

function project(row: SourceRow): TelegramGroupJournalEntry {
  return {
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    contentText: row.content_text,
    entryId: row.id,
    messageKind: row.message_kind,
    messageThreadId: row.message_thread_id,
    replyToSequenceId: row.reply_to_sequence_id,
    senderDisplayName: row.sender_display_name,
    senderUsername: row.sender_username,
    sentAt: row.sent_at.toISOString(),
    sequenceId: row.sequence_id,
  };
}

interface LaneRow {
  conversation_id: string;
  id: string;
  message_thread_id: string | null;
  processed_through_sequence: string;
}

interface PendingSourceRow {
  id: string;
  sent_at: Date;
  sequence_id: string;
}

async function insertBackgroundBatch(
  client: PoolClient,
  lane: LaneRow,
  sources: readonly PendingSourceRow[],
): Promise<void> {
  const first = sources[0]!;
  const last = sources.at(-1)!;
  const batch = await client.query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence,
        from_sequence, through_sequence, source_count)
     VALUES ($1, $2, 'background', 'pending', $3, $4, $5, $6) RETURNING id`,
    [lane.id, lane.conversation_id, lane.processed_through_sequence,
      first.sequence_id, last.sequence_id, sources.length],
  );
  await client.query(
    `INSERT INTO memory_review_batch_sources
       (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
     SELECT $1, $2, source.id, source.sequence_id
       FROM unnest($3::uuid[], $4::bigint[]) AS source(id, sequence_id)`,
    [batch.rows[0]!.id, lane.conversation_id, sources.map((source) => source.id),
      sources.map((source) => source.sequence_id)],
  );
}

async function pendingSources(client: PoolClient, lane: LaneRow): Promise<PendingSourceRow[]> {
  const result = await client.query<PendingSourceRow>(
    `SELECT message.id, message.sequence_id::text, message.sent_at
       FROM telegram_group_messages AS message
      WHERE message.conversation_id = $1 AND message.actor_kind IN ('user', 'telegram_bot')
        AND message.message_thread_id IS NOT DISTINCT FROM $2::bigint
        AND message.sequence_id > $3::bigint
      ORDER BY message.sequence_id LIMIT $4`,
    [lane.conversation_id, lane.message_thread_id, lane.processed_through_sequence,
      MEMORY_REVIEW_BATCH_SIZE],
  );
  return result.rows;
}

async function laneHasBatchAtCursor(client: PoolClient, lane: LaneRow): Promise<boolean> {
  const existing = await client.query(
    "SELECT 1 FROM memory_review_batches WHERE lane_id = $1 AND predecessor_sequence = $2",
    [lane.id, lane.processed_through_sequence],
  );
  return (existing.rowCount ?? 0) > 0;
}

async function lockedLanes(client: PoolClient, groupOnly: boolean): Promise<LaneRow[]> {
  const result = await client.query<LaneRow>(
    `SELECT lane.id, lane.conversation_id, lane.message_thread_id::text,
            lane.processed_through_sequence::text
       FROM memory_review_lanes AS lane
       JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
      WHERE ($1::boolean = false OR conversation.telegram_group_id IS NOT NULL)
      ORDER BY lane.created_at, lane.id FOR UPDATE OF lane`,
    [groupOnly],
  );
  return result.rows;
}

async function loadReviewMemoryContext(client: PoolClient, input: {
  authorTelegramUserIds: readonly string[];
  familyId: string;
  scope: "family" | "group" | "personal";
  scopePartitionKey: string;
}): Promise<ReviewMemoryContextItem[]> {
  // Claims about the batch authors plus subject-less claims of the same partition.
  const result = await client.query<ReviewMemoryContextItem>(
    `SELECT ref.memory_ref AS "memoryRef", item.kind::text AS kind, item.attribute, item.content,
            COALESCE(participant.display_name_snapshot, item.subject_label) AS "subjectLabel"
       FROM memory_items AS item
       JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
       LEFT JOIN conversation_participants AS participant
         ON participant.id = item.subject_participant_id
      WHERE item.family_id = $1 AND item.scope = $2 AND item.scope_partition_key = $3
        AND item.claim_status = 'active' AND item.sensitivity = 'normal'
        AND (participant.telegram_user_id = ANY($4::text[]) OR item.subject_participant_id IS NULL)
      ORDER BY item.updated_at DESC LIMIT $5`,
    [input.familyId, input.scope, input.scopePartitionKey, input.authorTelegramUserIds,
      MEMORY_REVIEW_CONTEXT_LIMIT],
  );
  return result.rows;
}

async function precedingContext(client: PoolClient, input: {
  conversationId: string;
  firstSequence: string;
  messageThreadId: string | null;
}): Promise<TelegramGroupJournalEntry[]> {
  // Both sides of the earlier conversation, newest first, then restored to timeline order.
  const result = await client.query<SourceRow>(
    `SELECT message.id, message.sequence_id::text, message.actor_kind, message.actor_id,
            message.message_thread_id::text, message.sender_username,
            message.sender_display_name, message.message_kind, message.content_text,
            message.reply_to_sequence_id::text, message.sent_at, message.telegram_user_id
       FROM telegram_group_messages AS message
      WHERE message.conversation_id = $1
        AND message.message_thread_id IS NOT DISTINCT FROM $2::bigint
        AND message.sequence_id < $3::bigint AND message.content_text IS NOT NULL
      ORDER BY message.sequence_id DESC LIMIT $4`,
    [input.conversationId, input.messageThreadId, input.firstSequence,
      MEMORY_REVIEW_PRECEDING_CONTEXT_LIMIT],
  );
  return result.rows.reverse().map(project);
}

async function materializeReadyBatches(client: PoolClient): Promise<void> {
  // This is the crash-recovery path for a committed 50th message whose inline observer did not run.
  for (const lane of await lockedLanes(client, true)) {
    if (await laneHasBatchAtCursor(client, lane)) continue;
    const sources = await pendingSources(client, lane);
    if (sources.length < MEMORY_REVIEW_BATCH_SIZE) continue;
    await insertBackgroundBatch(client, lane, sources);
  }
}

async function materializeIdleBatches(client: PoolClient, now: Date): Promise<void> {
  // Personal conversations never had lanes; create them from sequence 0 so history is reviewed once.
  await client.query(
    `INSERT INTO memory_review_lanes (conversation_id, message_thread_id, processed_through_sequence)
     SELECT conversation.id, NULL, 0
       FROM application_conversations AS conversation
      WHERE conversation.scope = 'personal'
     ON CONFLICT (conversation_id, message_thread_id) DO NOTHING`,
  );
  for (const lane of await lockedLanes(client, false)) {
    if (await laneHasBatchAtCursor(client, lane)) continue;
    const sources = await pendingSources(client, lane);
    const newest = sources.at(-1);
    if (!newest) continue;
    const silence = now.getTime() - newest.sent_at.getTime();
    const full = sources.length >= MEMORY_REVIEW_IDLE_MIN_SOURCES;
    const idle = silence >= MEMORY_REVIEW_IDLE_MILLISECONDS &&
      sources.length >= MEMORY_REVIEW_IDLE_MIN_BATCH_SOURCES;
    // A lone remark after a long silence still deserves one look; it just does not get its own call early.
    const longIdle = silence >= MEMORY_REVIEW_LONG_IDLE_MILLISECONDS;
    if (!full && !idle && !longIdle) continue;
    await insertBackgroundBatch(client, lane, sources);
  }
}

export const memoryReviewDispatchRepository = {
  ...memoryReviewDispatchTerminalRepository,
  async claimPending(input: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<MemoryReviewClaim[]> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await terminalizeStaleMemoryReviewBatches(client, input.now);
      await materializeReadyBatches(client);
      await materializeIdleBatches(client, input.now);
      const claimed = await client.query<{
        conversation_chat_id: string; conversation_id: string; family_id: string;
        scope_partition_key: string;
        group_id: string | null; group_type: "external" | "family_private" | null; id: string;
        lease_token: string; message_thread_id: string | null;
        scope: "family" | "group" | "personal"; source_count: number;
        sponsor_role: "member" | "owner" | "recovery_owner"; sponsor_telegram_user_id: string;
        sponsor_user_id: string; telegram_chat_id: string | null;
        telegram_chat_type: "group" | "supergroup" | null; through_sequence: string;
        tool_allowlist: string[] | null;
      }>(
         `WITH candidates AS (
           SELECT batch.id FROM memory_review_batches AS batch
            JOIN memory_review_lanes AS candidate_lane ON candidate_lane.id = batch.lane_id
            WHERE batch.batch_kind = 'background' AND (batch.status = 'pending' OR
              (batch.status = 'leased' AND batch.lease_expires_at <= $1))
              AND batch.predecessor_sequence = candidate_lane.processed_through_sequence
            ORDER BY batch.created_at, batch.id FOR UPDATE OF batch SKIP LOCKED LIMIT $2
         ), sponsors AS (
           -- A personal conversation is reviewed as its owner; a group as the family owner.
           SELECT conversation.id AS conversation_id, membership.user_id, membership.role
             FROM application_conversations AS conversation
             JOIN family_memberships AS membership
               ON membership.family_id = conversation.family_id
              AND membership.user_id = COALESCE(
                conversation.owner_user_id,
                (SELECT family_owner.user_id FROM family_memberships AS family_owner
                  WHERE family_owner.family_id = conversation.family_id
                    AND family_owner.role = 'owner' LIMIT 1))
         )
         UPDATE memory_review_batches AS batch
            SET status = 'leased', lease_token = gen_random_uuid(),
                lease_expires_at = $1 + $3 * interval '1 millisecond', updated_at = $1
           FROM candidates, memory_review_lanes AS lane,
                application_conversations AS conversation
                LEFT JOIN telegram_groups AS telegram_group
                  ON telegram_group.id = conversation.telegram_group_id,
                sponsors, users AS sponsor
          WHERE batch.id = candidates.id AND lane.id = batch.lane_id
            AND conversation.id = batch.conversation_id
            AND sponsors.conversation_id = conversation.id AND sponsor.id = sponsors.user_id
         RETURNING batch.id, batch.conversation_id, batch.through_sequence::text,
                   batch.source_count, batch.lease_token::text, lane.message_thread_id::text,
                   conversation.family_id, conversation.scope::text,
                   conversation.scope_partition_key,
                   conversation.telegram_chat_id AS conversation_chat_id,
                   telegram_group.id AS group_id, telegram_group.type::text AS group_type,
                   telegram_group.telegram_chat_id,
                   telegram_group.telegram_chat_type::text AS telegram_chat_type,
                   telegram_group.tool_allowlist,
                   sponsors.role::text AS sponsor_role,
                   sponsor.id AS sponsor_user_id,
                   sponsor.telegram_user_id AS sponsor_telegram_user_id`,
        [input.now, input.limit, input.leaseMilliseconds],
      );
      const claims: MemoryReviewClaim[] = [];
      for (const row of claimed.rows) {
        const personal = row.scope === "personal";
        if (!personal && (row.group_id === null || row.group_type === null)) throw new AppError(
          "AGENT_MEMORY_REVIEW_SPONSOR_INVALID",
          "Не удалось определить владельца проверки памяти",
        );
        const sources = await client.query<SourceRow>(
          `SELECT message.id, message.sequence_id::text, message.actor_kind, message.actor_id,
                  message.message_thread_id::text, message.sender_username,
                  message.sender_display_name, message.message_kind, message.content_text,
                  message.reply_to_sequence_id::text, message.sent_at, message.telegram_user_id
             FROM memory_review_batch_sources AS source
             JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
            WHERE source.batch_id = $1 ORDER BY source.timeline_sequence`,
          [row.id],
        );
        if (sources.rows.length !== row.source_count) throw new AppError(
          "AGENT_MEMORY_REVIEW_SOURCE_SET_INVALID",
          "Пакет проверки памяти не содержит ожидаемые сообщения",
        );
        const entries = sources.rows.map(project);
        const preceding = await precedingContext(client, {
          conversationId: row.conversation_id,
          firstSequence: sources.rows[0]!.sequence_id,
          messageThreadId: row.message_thread_id,
        });
        const existing = await loadReviewMemoryContext(client, {
          authorTelegramUserIds: [...new Set(sources.rows.flatMap((source) =>
            source.telegram_user_id === null ? [] : [source.telegram_user_id]))],
          familyId: row.family_id,
          scope: row.scope,
          scopePartitionKey: row.scope_partition_key,
        });
        claims.push({
          batchId: row.id, conversationId: row.conversation_id, entries,
          familyId: row.family_id,
          groupId: personal ? null : row.group_id,
          groupType: personal ? null : row.group_type,
          leaseToken: row.lease_token, messageThreadId: row.message_thread_id,
          memoryScopes: personal ? ["personal", "family"] : [row.scope],
          ownerTelegramUserId: row.sponsor_telegram_user_id, ownerUserId: row.sponsor_user_id,
          prompt: [
            formatExistingMemoryForReview(existing),
            formatPrecedingContextForReview(preceding),
            formatMemoryReviewBatchPrompt(entries),
          ].filter((block) => block.length > 0).join("\n\n"),
          role: row.group_type === "external" ? "external" : personal ? row.sponsor_role : "owner",
          scope: row.scope,
          sourceCount: entries.length, sourceEntryIds: sources.rows.map((source) => source.id),
          status: "pending",
          telegramChatId: personal ? row.conversation_chat_id : row.telegram_chat_id ?? row.conversation_chat_id,
          telegramChatType: personal ? "private" : row.telegram_chat_type ?? "supergroup",
          toolAllowlist: row.tool_allowlist ?? [],
          throughSequence: row.through_sequence,
        });
      }
      await client.query("COMMIT");
      return claims;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markDispatchStarted(
    batch: MemoryReviewClaim,
    applicationSessionId: string,
  ): Promise<boolean> {
    const result = await database().query(
      `UPDATE memory_review_batches
          SET status = 'dispatching', application_session_id = $3, updated_at = now()
        WHERE id = $1 AND status = 'leased' AND lease_token = $2`,
      [batch.batchId, batch.leaseToken, applicationSessionId],
    );
    return result.rowCount === 1;
  },

  async markRunning(
    batch: MemoryReviewClaim,
    input: { applicationSessionId: string; eveSessionId: string },
  ): Promise<void> {
    const result = await database().query(
      `UPDATE memory_review_batches
          SET status = 'running', eve_session_id = $4,
              started_at = coalesce(started_at, now()), updated_at = now(),
              lease_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND application_session_id = $3
          AND ((status = 'dispatching' AND lease_token = $2) OR
               (status = 'running' AND eve_session_id = $4))`,
      [batch.batchId, batch.leaseToken, input.applicationSessionId, input.eveSessionId],
    );
    if (result.rowCount !== 1) throw new AppError(
      "AGENT_MEMORY_REVIEW_RUNNING_STATE_INVALID", "Не удалось подтвердить запуск проверки памяти",
    );
  },

};
