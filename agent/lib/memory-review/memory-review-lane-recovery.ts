/** Measures lane progress without chat text and raises a stopped lane head to the owner. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";

import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";

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
      // A terminal handler may own the batch while waiting for our lane. Never let the alert FK
      // wait back on that handler: the next minute can fill the outbox after it releases the row.
      const available = await client.query(
        `SELECT 1 FROM memory_review_batches WHERE id = $1
          AND status IN ('failed', 'ambiguous') FOR KEY SHARE SKIP LOCKED`, [row.batch_id],
      );
      if (!available.rowCount) continue;
      if (!row.diagnostic_code) throw new AppError(
        "AGENT_MEMORY_REVIEW_DIAGNOSTIC_MISSING", "Для остановленной проверки памяти не сохранена причина ошибки",
      );
      await enqueueMemoryReviewOwnerAlert(client, row.batch_id, row.diagnostic_code);
    }
  }
  return result.rows;
}
