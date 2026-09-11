/** FIFO claims and immutable album snapshots, serialized with enqueue by the exact queue row. */
import { TELEGRAM_INGRESS_RECOVERY_MAX_ATTEMPTS } from "../config.js";
import { database } from "./database.js";
import { type ClaimRow, mapTelegramIngressClaim, requireLeaseMilliseconds } from "./telegram-ingress-contract.js";

export async function claimNextTelegramIngress(leaseMilliseconds: number) {
  requireLeaseMilliseconds(leaseMilliseconds);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ClaimRow>(
      `WITH admission AS MATERIALIZED (
          SELECT phase FROM runtime_maintenance WHERE singleton FOR SHARE
        ), candidate AS (
         SELECT item.update_id, queue.current_continuation_key
         FROM telegram_ingress_updates item
         JOIN telegram_ingress_queues queue ON queue.id = item.queue_id
           WHERE (item.status = 'pending'
               OR (item.status = 'processing' AND item.lease_expires_at <= now())
               OR (item.status = 'failed' AND item.last_error_code = 'AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED'
                 AND item.dispatch_session_id IS NOT NULL AND item.recovery_attempts < $2))
             AND (item.media_group_leader_id IS NULL OR item.media_group_late)
             AND (item.media_group_ready_at IS NULL OR item.media_group_closed_at IS NOT NULL
               OR item.media_group_ready_at <= now())
             AND EXISTS (SELECT 1 FROM admission WHERE phase = 'ready' OR
               (phase = 'draining' AND (item.dispatch_started_at IS NOT NULL OR item.payload ? 'callback_query')))
            AND NOT EXISTS (
              SELECT 1 FROM telegram_ingress_updates blocked
               WHERE blocked.queue_id = item.queue_id AND blocked.status = 'failed'
                 AND (blocked.media_group_leader_id IS NULL OR blocked.media_group_late)
                 AND blocked.last_error_code = 'AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED'
                 AND blocked.update_id <> item.update_id
            )
           AND NOT EXISTS (
             SELECT 1 FROM telegram_ingress_updates earlier
             WHERE earlier.queue_id = item.queue_id AND earlier.update_id < item.update_id
               AND (earlier.media_group_leader_id IS NULL OR earlier.media_group_late)
               AND earlier.status IN ('pending', 'processing')
           )
         ORDER BY item.update_id
         FOR UPDATE OF item, queue SKIP LOCKED
         LIMIT 1
       )
       UPDATE telegram_ingress_updates item
        SET status = 'processing', eve_session_id = NULL,
            attempt_count = attempt_count + 1,
            recovery_attempts = recovery_attempts + CASE WHEN dispatch_started_at IS NULL THEN 0 ELSE 1 END,
            completed_at = NULL, lease_token = gen_random_uuid(),
            lease_expires_at = now() + ($1 * interval '1 millisecond'),
            last_error_code = NULL, last_error_message = NULL, updated_at = now(),
            media_group_closed_at = CASE WHEN media_group_key IS NULL THEN NULL
              ELSE COALESCE(media_group_closed_at, now()) END
       FROM candidate WHERE item.update_id = candidate.update_id
       RETURNING item.update_id::text, item.queue_id, item.ingress_continuation_key,
          item.payload, item.attempt_count, item.lease_token::text, item.lease_expires_at,
          item.dispatch_started_at, item.dispatch_id::text, item.dispatch_session_id,
          item.dispatch_turn_id, item.dispatch_start_index::text, item.recovery_cancel_requested,
          item.voice_file_id, item.voice_file_size::text, item.voice_mime_type,
          item.voice_transcript, item.media_group_key, item.media_group_late, candidate.current_continuation_key`,
      [leaseMilliseconds, TELEGRAM_INGRESS_RECOVERY_MAX_ATTEMPTS],
    );
    const row = result.rows[0];
    const claim = row ? mapTelegramIngressClaim(row) : null;
    if (claim && row && row.media_group_key !== null) {
      const members = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM telegram_ingress_updates
         WHERE update_id = $1 OR (media_group_leader_id = $1 AND NOT media_group_late)
         ORDER BY update_id`, [claim.updateId],
      );
      claim.mediaGroupPayloads = members.rows.map(member => member.payload);
    }
    await client.query("COMMIT");
    return claim;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
