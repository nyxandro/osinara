/** Revoking an unbound attempt and pre-model binding serialize on the same row. */
import { database } from "./database.js";
import { AppError } from "./app-error.js";

export async function recoverUnboundTelegramPreparation(updateId: string, leaseToken: string): Promise<"released" | "bound" | "legacy" | "callback"> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ recovery_protocol: number; dispatch_session_id: string | null; response_session_id: string | null; dispatch_kind: string | null; callback: boolean }>(
      `SELECT recovery_protocol,dispatch_session_id,response_session_id,dispatch_kind,payload ? 'callback_query' AS callback FROM telegram_ingress_updates
       WHERE update_id=$1 AND status='processing' AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE`, [updateId, leaseToken]);
    const row = result.rows[0];
    if (!row) throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Обработка сообщения уже принадлежит другому процессу");
    if (row.dispatch_session_id !== null) { await client.query("COMMIT"); return "bound"; }
    if (row.recovery_protocol !== 1) { await client.query("COMMIT"); return "legacy"; }
    if (row.callback || row.dispatch_kind === "respond" || row.response_session_id !== null) { await client.query("COMMIT"); return "callback"; }
    // A late native start carries the revoked dispatch id and cannot acquire the pre-model fence.
    await client.query(`UPDATE telegram_ingress_updates SET status='pending',lease_token=NULL,lease_expires_at=NULL,
      dispatch_id=NULL,dispatch_started_at=NULL,dispatch_continuation_key=NULL,dispatch_kind=NULL,
      updated_at=now() WHERE update_id=$1`, [updateId]);
    await client.query(`INSERT INTO telegram_ingress_recovery_events(update_id,action,reason)
      VALUES($1,'observe','Revoked protocol-1 attempt without an admitted Eve turn; resume preparation')`, [updateId]);
    await client.query("COMMIT");
    return "released";
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
