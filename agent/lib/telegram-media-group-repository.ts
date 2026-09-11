/** Album membership shares the queue row lock with claim: sealed dispatch input never grows. */
import type { PoolClient } from "pg";
import { privateTelegramMediaGroupKey, TELEGRAM_MEDIA_GROUP_QUIET_MS } from "./telegram-media-group.js";
import type { EnqueueTelegramUpdateInput } from "./telegram-ingress-contract.js";

export async function registerTelegramMediaGroupMember(
  client: PoolClient, input: EnqueueTelegramUpdateInput, queueId: string,
): Promise<void> {
  const key = privateTelegramMediaGroupKey(input.payload);
  if (key === null) return;
  const result = await client.query<{ update_id: string; media_group_closed_at: Date | null }>(
    `SELECT update_id::text, media_group_closed_at FROM telegram_ingress_updates
     WHERE queue_id = $1 AND media_group_key = $2`, [queueId, key],
  );
  const leader = result.rows[0];
  if (!leader) {
    await client.query(
      `UPDATE telegram_ingress_updates SET media_group_key = $2,
         media_group_ready_at = clock_timestamp() + ($3 * interval '1 millisecond') WHERE update_id = $1`,
      [input.updateId, key, TELEGRAM_MEDIA_GROUP_QUIET_MS],
    );
    return;
  }
  await client.query(
    `UPDATE telegram_ingress_updates SET media_group_leader_id = $2, media_group_late = $3
     WHERE update_id = $1`, [input.updateId, leader.update_id, leader.media_group_closed_at !== null],
  );
  if (leader.media_group_closed_at === null) {
    await client.query(
      `UPDATE telegram_ingress_updates
       SET media_group_ready_at = clock_timestamp() + ($2 * interval '1 millisecond') WHERE update_id = $1`,
      [leader.update_id, TELEGRAM_MEDIA_GROUP_QUIET_MS],
    );
  }
}

/** Embed after a CTE named `finished` returning the leader row. The leader's lease guards all members. */
export const settleTelegramMediaGroupMembersSql = `settled_members AS (
  UPDATE telegram_ingress_updates member
  SET status = finished.status, eve_session_id = finished.eve_session_id,
      last_error_code = finished.last_error_code, last_error_message = finished.last_error_message,
      completed_at = finished.completed_at, updated_at = now()
  FROM finished
  WHERE member.media_group_leader_id = finished.update_id AND NOT member.media_group_late
  RETURNING member.update_id
)`;
