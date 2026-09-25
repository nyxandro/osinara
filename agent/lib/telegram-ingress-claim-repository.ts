/** FIFO claims and immutable album snapshots, serialized with enqueue and wake-ups by the exact queue row. */
import { TELEGRAM_INGRESS_RECOVERY_MAX_ATTEMPTS } from "../config.js";
import { database } from "./database.js";
import {
  type ClaimRow,
  mapTelegramIngressClaim,
  requireLeaseMilliseconds,
  type TelegramPrivateBurstPolicy,
} from "./telegram-ingress-contract.js";
import { joinTelegramBurst, requireTelegramPrivateBurstPolicy } from "./telegram-private-burst.js";

export async function claimNextTelegramIngress(leaseMilliseconds: number, burst: TelegramPrivateBurstPolicy) {
  requireLeaseMilliseconds(leaseMilliseconds);
  requireTelegramPrivateBurstPolicy(burst);
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
                  AND (item.dispatch_session_id IS NOT NULL OR item.response_session_id IS NOT NULL) AND item.recovery_attempts < $2))
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
           -- A private chat still receiving a burst is left alone until it has been quiet for the
           -- window, or the cap has passed since its head arrived. Only a new message waits for it.
           -- A button press has no message and must compare as not private, never as unknown.
           AND NOT (item.status = 'pending' AND (item.payload #>> '{message,chat,type}') IS NOT DISTINCT FROM 'private'
             AND item.received_at > now() - ($4 * interval '1 millisecond')
             AND EXISTS (
               SELECT 1 FROM telegram_ingress_updates latest
                WHERE latest.queue_id = item.queue_id AND latest.status = 'pending' AND latest.payload ? 'message'
                  AND latest.received_at > now() - ($3 * interval '1 millisecond')
             ))
           -- A wake-up turn of this chat owns the lane until its item is terminal, like an earlier update.
           -- The mark lives on the locked queue row, so a wake-up claimed concurrently is rechecked here.
           AND queue.active_wakeup_id IS NULL
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
           item.dispatch_started_at, item.dispatch_id::text, item.dispatch_session_id, item.recovery_protocol,
           item.dispatch_turn_id, item.dispatch_start_index::text, item.recovery_cancel_requested,
           item.response_session_id,item.response_turn_id,item.response_start_index::text,
          item.voice_file_id, item.voice_file_size::text, item.voice_mime_type,
          item.voice_transcript, item.media_group_key, item.media_group_late, candidate.current_continuation_key`,
      [leaseMilliseconds, TELEGRAM_INGRESS_RECOVERY_MAX_ATTEMPTS, burst.quietMilliseconds, burst.maxWaitMilliseconds],
    );
    const row = result.rows[0];
    const claim = row ? mapTelegramIngressClaim(row) : null;
    // A private head takes the messages already waiting behind it into the same turn. An album and
    // a late album member are handled as they always were.
    if (claim && row && row.media_group_key === null && !row.media_group_late) {
      const joined = await joinTelegramBurst(client, {
        dispatchStarted: claim.dispatchStarted, payload: claim.payload, queueId: claim.queueId, updateId: claim.updateId,
      }, burst);
      if (joined) claim.burstPayloads = joined;
    }
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
