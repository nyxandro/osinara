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
} from "./memory-review-config.js";
import {
  memoryReviewDispatchTerminalRepository,
  terminalizeStaleMemoryReviewBatches,
} from "./memory-review-dispatch-terminal-repository.js";
import { formatMemoryReviewBatchPrompt } from "./memory-review-prompt.js";
import type { MemoryReviewClaim } from "./memory-review-repository.js";
import { readMemoryReviewLaneHealth, recoverUnstartedReviewBatches } from "./memory-review-lane-recovery.js";

interface SourceRow {
  actor_id: string;
  actor_kind: "agent_self" | "user";
  content_text: string | null;
  id: string;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sender_username: string | null;
  sent_at: Date;
  sequence_id: string;
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

async function materializeReadyBatches(client: PoolClient, now: Date): Promise<void> {
  // This is the crash-recovery path for a committed 50th message whose inline observer did not run.
  const lanes = await client.query<{
    conversation_id: string;
    id: string;
    message_thread_id: string | null;
    processed_through_sequence: string;
  }>(
    `SELECT lane.id, lane.conversation_id, lane.message_thread_id::text,
            lane.processed_through_sequence::text
       FROM memory_review_lanes AS lane
       JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
       JOIN telegram_groups AS telegram_group ON telegram_group.id = conversation.telegram_group_id
      ORDER BY lane.created_at, lane.id FOR UPDATE OF lane`,
  );
  // Recovery must not take one later lane before this globally ordered set: another dispatcher
  // could hold an earlier lane while waiting for that same later lane.
  await recoverUnstartedReviewBatches(client, now);
  for (const lane of lanes.rows) {
    const existing = await client.query<{ status: string; through_sequence: string }>(
      `SELECT status::text, through_sequence::text FROM memory_review_batches
        WHERE lane_id = $1 AND predecessor_sequence = $2`,
      [lane.id, lane.processed_through_sequence],
    );
    if (existing.rows[0]) continue;
    const sources = await client.query<{ id: string; sequence_id: string }>(
      `SELECT message.id, message.sequence_id::text
         FROM telegram_group_messages AS message
        WHERE message.conversation_id = $1 AND message.actor_kind IN ('user', 'telegram_bot')
          AND message.message_thread_id IS NOT DISTINCT FROM $2::bigint
          AND message.sequence_id > $3::bigint
        ORDER BY message.sequence_id LIMIT $4`,
      [lane.conversation_id, lane.message_thread_id, lane.processed_through_sequence,
        MEMORY_REVIEW_BATCH_SIZE],
    );
    if (sources.rows.length < MEMORY_REVIEW_BATCH_SIZE) continue;
    const first = sources.rows[0]!;
    const last = sources.rows.at(-1)!;
    const batch = await client.query<{ id: string }>(
      `INSERT INTO memory_review_batches
         (lane_id, conversation_id, batch_kind, status, predecessor_sequence,
          from_sequence, through_sequence, source_count)
       VALUES ($1, $2, 'background', 'pending', $3, $4, $5, $6) RETURNING id`,
      [lane.id, lane.conversation_id, lane.processed_through_sequence,
        first.sequence_id, last.sequence_id, sources.rows.length],
    );
    await client.query(
      `INSERT INTO memory_review_batch_sources
         (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
       SELECT $1, $2, source.id, source.sequence_id
         FROM unnest($3::uuid[], $4::bigint[]) AS source(id, sequence_id)`,
      [batch.rows[0]!.id, lane.conversation_id, sources.rows.map((source) => source.id),
        sources.rows.map((source) => source.sequence_id)],
    );
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
      await materializeReadyBatches(client, input.now);
      const laneHealth = await readMemoryReviewLaneHealth(client);
      const claimed = await client.query<{
        conversation_id: string; family_id: string; group_id: string;
        group_type: "external" | "family_private"; id: string; lease_token: string;
        message_thread_id: string | null; owner_telegram_user_id: string; owner_user_id: string;
        scope: "family" | "group"; telegram_chat_id: string;
        source_count: number;
        telegram_chat_type: "group" | "supergroup"; through_sequence: string;
        tool_allowlist: string[];
      }>(
         `WITH candidates AS (
           SELECT batch.id FROM memory_review_batches AS batch
            JOIN memory_review_lanes AS candidate_lane ON candidate_lane.id = batch.lane_id
            WHERE batch.batch_kind = 'background' AND (batch.status = 'pending' OR
              (batch.status = 'leased' AND batch.lease_expires_at <= $1))
              AND batch.predecessor_sequence = candidate_lane.processed_through_sequence
            ORDER BY batch.created_at, batch.id FOR UPDATE OF batch SKIP LOCKED LIMIT $2
         )
         UPDATE memory_review_batches AS batch
            SET status = 'leased', lease_token = gen_random_uuid(),
                lease_expires_at = $1 + $3 * interval '1 millisecond', updated_at = $1
           FROM candidates, memory_review_lanes AS lane,
                application_conversations AS conversation, telegram_groups AS telegram_group,
                family_memberships AS membership, users AS owner
          WHERE batch.id = candidates.id AND lane.id = batch.lane_id
            AND conversation.id = batch.conversation_id
            AND telegram_group.id = conversation.telegram_group_id
            AND membership.family_id = conversation.family_id AND membership.role = 'owner'
            AND owner.id = membership.user_id
          RETURNING batch.id, batch.conversation_id, batch.through_sequence::text, batch.source_count,
                   batch.lease_token::text, lane.message_thread_id::text,
                   conversation.family_id, conversation.scope::text,
                   telegram_group.id AS group_id, telegram_group.type::text AS group_type,
                   telegram_group.telegram_chat_id,
                   telegram_group.telegram_chat_type::text AS telegram_chat_type,
                   telegram_group.tool_allowlist,
                   owner.id AS owner_user_id,
                   owner.telegram_user_id AS owner_telegram_user_id`,
        [input.now, input.limit, input.leaseMilliseconds],
      );
      const claims: MemoryReviewClaim[] = [];
      for (const row of claimed.rows) {
        const sources = await client.query<SourceRow>(
          `SELECT message.id, message.sequence_id::text, message.actor_kind, message.actor_id,
                  message.message_thread_id::text, message.sender_username,
                  message.sender_display_name, message.message_kind, message.content_text,
                  message.reply_to_sequence_id::text, message.sent_at
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
        claims.push({
          batchId: row.id, conversationId: row.conversation_id, entries,
          familyId: row.family_id, groupId: row.group_id, groupType: row.group_type,
          leaseToken: row.lease_token, messageThreadId: row.message_thread_id,
          ownerTelegramUserId: row.owner_telegram_user_id, ownerUserId: row.owner_user_id,
          prompt: formatMemoryReviewBatchPrompt(entries), scope: row.scope,
          sourceCount: entries.length, sourceEntryIds: sources.rows.map((source) => source.id),
          status: "pending", telegramChatId: row.telegram_chat_id,
          telegramChatType: row.telegram_chat_type,
          toolAllowlist: row.tool_allowlist,
          throughSequence: row.through_sequence,
        });
      }
      await client.query("COMMIT");
      for (const lane of laneHealth) {
        const blocked = lane.head_status === "failed" || lane.head_status === "ambiguous";
        (blocked ? console.error : console.info)(JSON.stringify({
          code: blocked ? "AGENT_MEMORY_REVIEW_LANE_BLOCKED" : "AGENT_MEMORY_REVIEW_LANE_METRICS",
          laneId: lane.lane_id, batchId: lane.batch_id, headStatus: lane.head_status,
          diagnosticCode: lane.diagnostic_code, processedThroughSequence: lane.processed_through_sequence,
          waitingSources: lane.waiting_sources, oldestUnreviewedAt: lane.oldest_unreviewed_at,
        }));
      }
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
