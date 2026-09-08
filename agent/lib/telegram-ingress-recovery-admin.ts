/** Operator requests a fresh observation/cancellation, never blind replay or quarantine erasure. */
import { database } from "./database.js";
import { AppError } from "./app-error.js";
import { requireUpdateId } from "./telegram-ingress-contract.js";

export async function requestTelegramIngressRecovery(updateId: string, action: "observe" | "cancel", reason: string): Promise<void> {
  requireUpdateId(updateId);
  if (!["observe", "cancel"].includes(action) || !reason.trim() || reason.length > 1000) {
    throw new AppError("AGENT_TELEGRAM_RECOVERY_INPUT_INVALID", "Укажите действие и причину восстановления длиной до 1000 символов");
  }
  const result = await database().query(
    `WITH requested AS (
       UPDATE telegram_ingress_updates SET recovery_attempts = 0,
         recovery_cancel_requested = $2, updated_at = now()
       WHERE update_id = $1 AND status = 'failed'
         AND last_error_code = 'AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED'
         AND dispatch_session_id IS NOT NULL AND dispatch_turn_id IS NOT NULL AND dispatch_id IS NOT NULL
       RETURNING update_id
     ) INSERT INTO telegram_ingress_recovery_events (update_id, action, reason)
       SELECT update_id, $3, $4 FROM requested RETURNING update_id`,
    [updateId, action === "cancel", action, reason.trim()],
  );
  if (result.rowCount !== 1) throw new AppError("AGENT_TELEGRAM_RECOVERY_NOT_ADMISSIBLE",
    "Запрос не заблокирован или не имеет сохранённой привязки к Eve. Для старой записи сначала требуется отдельная проверка исходного исполнения");
}
