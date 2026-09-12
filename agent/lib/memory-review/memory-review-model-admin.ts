/** Explicit operator recovery for an inspected historical model failure; never sends to Eve. */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { isRecoverableModelCode } from "../model-failure.js";
import { lockReviewAttempt, requireReviewSources, reviewAttemptHasWrites, hasPendingReviewWrite } from "./memory-review-attempt.js";
import { recordReviewModelWait } from "./memory-review-model-recovery.js";

export async function recoverEmptyReviewModelFailure(input: {
  batchId: string; expectedEveSessionId: string; causeCode: string; reason: string; modelRouteKey: string;
}, dependencies: { isEveSessionTerminal(id: string): Promise<boolean> }): Promise<"waiting" | "replayed"> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(input.batchId) ||
      !input.expectedEveSessionId.trim() || !isRecoverableModelCode(input.causeCode) ||
      !input.reason.trim() || input.reason.length > 2000 || !/^[0-9a-f]{64}$/u.test(input.modelRouteKey)) {
    throw new AppError("AGENT_MEMORY_REVIEW_RECOVERY_INPUT_INVALID", "Укажите пакет, точную сессию, подтверждённую причину сбоя модели и пояснение");
  }
  // Native terminal state is immutable. Verify it before taking application locks across databases.
  if (!await dependencies.isEveSessionTerminal(input.expectedEveSessionId)) throw new AppError(
    "AGENT_MEMORY_REVIEW_RECOVERY_SESSION_UNCONFIRMED", "Завершение исходной сессии не подтверждено. Восстановление не выполнено",
  );
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const batch = await lockReviewAttempt(client, input.batchId);
    if (!batch || batch.batch_kind !== "background" || batch.eve_session_id !== input.expectedEveSessionId ||
        !batch.eve_turn_id || !batch.application_session_id) throw new AppError(
      "AGENT_MEMORY_REVIEW_RECOVERY_STATE_CHANGED", "Состояние пакета изменилось или его контекст отсутствует. Повторите inspect",
    );
    if (batch.status === "waiting_model") { await client.query("COMMIT"); return "replayed"; }
    if (!["failed", "ambiguous"].includes(batch.status)) throw new AppError(
      "AGENT_MEMORY_REVIEW_RECOVERY_STATE_CHANGED", "Пакет не ожидает ручного восстановления. Повторите inspect",
    );
    const session = await client.query(
      `SELECT 1 FROM conversation_sessions WHERE id = $1 AND retired_at IS NOT NULL
        AND eve_session_id = $2 AND memory_review_batch_id = $3 FOR UPDATE SKIP LOCKED`,
      [batch.application_session_id, input.expectedEveSessionId, batch.id],
    );
    if (session.rowCount !== 1) throw new AppError(
      "AGENT_MEMORY_REVIEW_RECOVERY_SESSION_UNCONFIRMED", "Исходный контекст проверки ещё не закрыт или недоступен",
    );
    await requireReviewSources(client, batch);
    if (await reviewAttemptHasWrites(client, batch) || await hasPendingReviewWrite(client, batch.id)) throw new AppError(
      "AGENT_MEMORY_REVIEW_RECOVERY_WRITES_FOUND", "Обнаружены записи или незавершённые операции памяти. Автоматический повтор запрещён",
    );
    await client.query("UPDATE memory_review_batches SET model_route_key = $2 WHERE id = $1", [batch.id, input.modelRouteKey]);
    await recordReviewModelWait(client, { ...batch, model_route_key: input.modelRouteKey }, input.causeCode, new Date());
    await client.query(`INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
      SELECT family_id, 'memory_review.operator_model_recovery', $2, $3::jsonb
      FROM application_conversations WHERE id = $1`, [batch.conversation_id, batch.id, JSON.stringify({
      reason: input.reason.trim(), previousDiagnosticCode: batch.diagnostic_code,
      causeCode: input.causeCode, expectedEveSessionId: input.expectedEveSessionId,
    })]);
    await client.query("COMMIT");
    return "waiting";
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
}
