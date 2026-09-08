/** Bind verified dispatch provenance before model execution, including native HITL boundaries. */
import type { SessionAuth } from "eve/context";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { requireNonEmpty, requireUpdateId, requireUuid } from "./telegram-ingress-contract.js";

export async function bindTelegramIngressTurn(auth: SessionAuth, sessionId: string, turnId: string, boundary = false): Promise<void> {
  const attributes = auth.current?.attributes;
  const updateId = attributes?.osinaraTelegramUpdateId;
  // Scheduled/native child turns and already persisted pre-migration auth have no update binding.
  if (updateId === undefined) return;
  const dispatchId = attributes?.osinaraTelegramIngressId;
  if (typeof updateId !== "string" || typeof dispatchId !== "string") {
    throw new AppError("AGENT_TELEGRAM_DISPATCH_ID_INVALID", "Не удалось проверить источник обработки сообщения");
  }
  requireUpdateId(updateId);
  requireUuid(dispatchId, "AGENT_TELEGRAM_DISPATCH_ID_INVALID", "Не удалось проверить идентификатор обработки сообщения");
  requireNonEmpty(sessionId, "AGENT_TELEGRAM_SESSION_INVALID", "Не удалось определить сессию сообщения");
  requireNonEmpty(turnId, "AGENT_TELEGRAM_TURN_INVALID", "Не удалось определить ход сообщения");
  const result = await database().query(
    `UPDATE telegram_ingress_updates item
        SET dispatch_session_id = $3, dispatch_turn_id = $4,
            dispatch_start_index = COALESCE(item.dispatch_start_index,
              (SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id = $3), 0)
      WHERE item.update_id = $1 AND item.dispatch_id = $2 AND item.dispatch_started_at IS NOT NULL
        AND (item.status = 'processing' OR ($5 AND item.dispatch_session_id = $3 AND item.dispatch_turn_id = $4) OR
          (item.status = 'failed' AND item.last_error_code = 'AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED'))
        AND (item.dispatch_session_id IS NULL OR
          (item.dispatch_session_id = $3 AND item.dispatch_turn_id = $4))
      RETURNING item.update_id`,
    [updateId, dispatchId, sessionId, turnId, boundary],
  );
  if (result.rowCount !== 1) throw new AppError("AGENT_TELEGRAM_DISPATCH_BINDING_REJECTED",
    "Обработка сообщения уже закрыта или принадлежит другому запросу. Выполнение остановлено");
}
