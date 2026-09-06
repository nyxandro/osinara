/** Repairs only the persisted pre-Eve incident class and measures lane progress without chat text. */
import type { PoolClient } from "pg";

import { MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE } from "./memory-review-config.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";

const LEGACY_UNSTARTED_CODE = "AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS";

export async function recoverUnstartedReviewBatches(client: PoolClient, now: Date): Promise<void> {
  // This code was emitted before unstarted turns were released/skipped. A retired or absent
  // application root, no Eve binding, no source-set and no evidence exclude replaying memory writes.
  // Keys never change: NO KEY UPDATE keeps competing recovery exclusive but lets an owner-alert
  // FK take KEY SHARE while another dispatcher holds the lane we are about to acquire.
  const candidates = await client.query<{ id: string; lane_id: string }>(
    `SELECT batch.id, batch.lane_id FROM memory_review_batches AS batch
      LEFT JOIN conversation_sessions AS session ON session.id = batch.application_session_id
      WHERE batch.batch_kind = 'interactive' AND batch.status = 'ambiguous'
        AND batch.diagnostic_code = $1 AND batch.recovery_attempts = 0
        AND batch.eve_session_id IS NULL AND batch.eve_turn_id IS NULL
        AND (session.id IS NULL OR session.retired_at IS NOT NULL)
      ORDER BY batch.created_at, batch.id FOR NO KEY UPDATE OF batch SKIP LOCKED LIMIT $2`,
    [LEGACY_UNSTARTED_CODE, MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE],
  );
  for (const batch of candidates.rows) {
    await client.query("SELECT 1 FROM memory_review_lanes WHERE id = $1 FOR UPDATE", [batch.lane_id]);
    // Keep the same range and links. A completed successor is neither replayed nor detached.
    // Refuse repair if retained evidence no longer agrees with the original batch.
    const recovered = await client.query<{ conversation_id: string; source_count: number }>(
      `UPDATE memory_review_batches AS batch
        SET batch_kind = 'background', status = 'pending', application_session_id = NULL,
            lease_token = NULL, lease_expires_at = NULL, diagnostic_code = NULL,
            started_at = NULL, completed_at = NULL, recovery_attempts = 1,
            last_recovery_diagnostic_code = $2, last_recovered_at = $3, updated_at = $3
        FROM memory_review_lanes AS lane
        WHERE batch.id = $1 AND lane.id = batch.lane_id
          AND lane.conversation_id = batch.conversation_id
          AND batch.predecessor_sequence >= lane.processed_through_sequence
          AND NOT EXISTS (
            SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = batch.id
          )
          AND (SELECT count(*) FROM memory_review_batch_sources WHERE batch_id = batch.id) = batch.source_count
          AND (SELECT min(timeline_sequence) FROM memory_review_batch_sources WHERE batch_id = batch.id) = batch.from_sequence
          AND (SELECT max(timeline_sequence) FROM memory_review_batch_sources WHERE batch_id = batch.id) = batch.through_sequence
          AND NOT EXISTS (
            SELECT 1 FROM memory_review_batch_sources AS source
            JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
            WHERE source.batch_id = batch.id AND (
              source.conversation_id <> batch.conversation_id OR
              message.conversation_id <> batch.conversation_id OR
              message.sequence_id <> source.timeline_sequence OR
              message.message_thread_id IS DISTINCT FROM lane.message_thread_id OR
              message.actor_kind <> 'user'
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM claim_evidence AS evidence
            WHERE evidence.origin_conversation_id = batch.conversation_id
              AND evidence.timeline_sequence BETWEEN batch.from_sequence AND batch.through_sequence
          )
        RETURNING batch.conversation_id, batch.source_count`,
      [batch.id, LEGACY_UNSTARTED_CODE, now],
    );
    const row = recovered.rows[0];
    if (!row) continue;
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       SELECT family_id, 'memory_review.recovered', $2,
         jsonb_build_object('diagnosticCode', $3::text, 'recoveryAttempt', 1, 'sourceCount', $4::integer)
       FROM application_conversations WHERE id = $1`,
      [row.conversation_id, batch.id, LEGACY_UNSTARTED_CODE, row.source_count],
    );
  }
}

export async function readMemoryReviewLaneHealth(client: PoolClient) {
  const result = await client.query<{
    batch_id: string | null;
    diagnostic_code: string | null;
    head_status: string | null;
    lane_id: string;
    oldest_unreviewed_at: Date | null;
    processed_through_sequence: string;
    waiting_sources: number;
  }>(
    `SELECT lane.id AS lane_id, lane.processed_through_sequence::text,
            batch.id AS batch_id, batch.status::text AS head_status, batch.diagnostic_code,
            backlog.waiting_sources, backlog.oldest_unreviewed_at
     FROM memory_review_lanes AS lane
     JOIN application_conversations AS conversation ON conversation.id = lane.conversation_id
     JOIN telegram_groups AS telegram_group ON telegram_group.id = conversation.telegram_group_id
     LEFT JOIN memory_review_batches AS batch ON batch.lane_id = lane.id
       AND batch.predecessor_sequence = lane.processed_through_sequence
     CROSS JOIN LATERAL (
       SELECT count(*)::integer AS waiting_sources, min(message.sent_at) AS oldest_unreviewed_at
       FROM telegram_group_messages AS message
       WHERE message.conversation_id = lane.conversation_id
         AND message.message_thread_id IS NOT DISTINCT FROM lane.message_thread_id
         AND message.actor_kind IN ('user', 'telegram_bot')
         AND message.sequence_id > lane.processed_through_sequence
     ) AS backlog`,
  );
  for (const row of result.rows) {
    if (row.batch_id && (row.head_status === "failed" || row.head_status === "ambiguous")) {
      await enqueueMemoryReviewOwnerAlert(client, row.batch_id, "AGENT_MEMORY_REVIEW_LANE_BLOCKED");
    }
  }
  return result.rows;
}
