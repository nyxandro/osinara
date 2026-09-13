/** A consumed text answer resumes its verified original session, even after pending_operation was cleared. */
import { database } from "../database.js";
import { AppError } from "../app-error.js";
import type { PreparedSession, PrepareSessionInput } from "./session-repository.js";

export async function prepareAuthorizedResponse(input: Omit<PrepareSessionInput,"kind" | "baseContinuationToken"> & {
  ingress: { updateId: string; dispatchId: string };
}): Promise<PreparedSession & { nativeSessionId: string }> {
  const result = await database().query<{ id: string; generation: number; continuation_token: string; thread_id: string; eve_session_id: string }>(
    `SELECT session.id,session.generation,session.continuation_token,session.thread_id,session.eve_session_id
     FROM telegram_ingress_updates item
     JOIN telegram_hitl_approvals approval ON approval.consumed_reply_update_id=item.update_id AND approval.consumed_at IS NOT NULL
     JOIN conversation_sessions session ON session.id=approval.application_session_id AND session.eve_session_id=approval.eve_session_id
     WHERE item.update_id=$1 AND item.dispatch_id=$2 AND item.status='processing' AND item.lease_expires_at>now()
       AND item.payload#>>'{message,from,id}'=approval.expected_telegram_user_id
       AND session.retired_at IS NULL AND session.kind<>'proactive' AND session.family_id=$3
       AND session.group_id IS NOT DISTINCT FROM $4::uuid AND session.owner_user_id IS NOT DISTINCT FROM $5::uuid
       AND session.scope=$6 FOR SHARE OF item,approval,session`,
  [input.ingress.updateId,input.ingress.dispatchId,input.familyId,input.groupId,input.userId,input.scope]);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row) throw new AppError("AGENT_RESPONSE_ROUTE_INVALID", "Не удалось проверить контекст сохранённого ответа");
  return { id: row.id,generation: row.generation,continuationToken: row.continuation_token,
    sandboxSessionId: row.thread_id,rotated: false,nativeSessionId: row.eve_session_id };
}
