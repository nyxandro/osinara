/** Approval consumption and its exact ingress execution coordinates commit together. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";

export async function bindCallbackIngress(client: PoolClient, input: {
  updateId: string; dispatchId: string; callbackQueryId: string; callbackData: string; telegramUserId: string;
}, target: { sessionId: string; turnId: string | null }): Promise<void> {
  const result = await client.query(`UPDATE telegram_ingress_updates item
    SET recovery_protocol=CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,
      response_session_id=CASE WHEN $5::text IS NULL THEN NULL ELSE $4 END,
      response_turn_id=$5,response_start_index=CASE WHEN $5::text IS NULL THEN NULL ELSE
        coalesce(item.response_start_index,(SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id=$4),0) END,
      dispatch_kind='respond'
    WHERE update_id=$1 AND dispatch_id=$2 AND payload#>>'{callback_query,id}'=$3
      AND payload#>>'{callback_query,data}'=$6 AND payload#>>'{callback_query,from,id}'=$7
      AND status='processing' AND lease_expires_at>now()
      AND (response_session_id IS NULL OR (response_session_id=$4 AND response_turn_id=$5))
      AND (dispatch_session_id IS NULL OR dispatch_session_id=$4) RETURNING update_id`,
  [input.updateId,input.dispatchId,input.callbackQueryId,target.sessionId,target.turnId,input.callbackData,input.telegramUserId]);
  if (result.rowCount !== 1) throw new AppError("AGENT_TELEGRAM_CALLBACK_ATTEMPT_STALE", "Попытка обработки подтверждения уже закрыта");
}

export async function bindTextReplyIngress(client: PoolClient, input: {
  updateId: string; dispatchId: string; telegramUserId: string; chatId: string; promptMessageId: string;
}, target: { sessionId: string; turnId: string | null }): Promise<void> {
  const result = await client.query(`UPDATE telegram_ingress_updates item SET
    recovery_protocol=CASE WHEN $4::text IS NULL THEN 0 ELSE 1 END,
    response_session_id=CASE WHEN $4::text IS NULL THEN NULL ELSE $3 END,response_turn_id=$4,
    response_start_index=CASE WHEN $4::text IS NULL THEN NULL ELSE coalesce(item.response_start_index,
      (SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id=$3),0) END
    WHERE update_id=$1 AND dispatch_id=$2 AND status='processing' AND lease_expires_at>now()
      AND payload#>>'{message,from,id}'=$5 AND payload#>>'{message,chat,id}'=$6
      AND payload#>>'{message,reply_to_message,message_id}'=$7
      AND (response_session_id IS NULL OR (response_session_id=$3 AND response_turn_id=$4))
      AND (dispatch_session_id IS NULL OR dispatch_session_id=$3) RETURNING update_id`,
  [input.updateId,input.dispatchId,target.sessionId,target.turnId,input.telegramUserId,input.chatId,input.promptMessageId]);
  if (result.rowCount !== 1) throw new AppError("AGENT_TELEGRAM_REPLY_ATTEMPT_STALE", "Попытка обработки ответа уже закрыта");
}
