/** Reconcile an exact terminal native task whose application completion was lost with the DB connection. */
import { database } from "../database.js";
import { SESSION_RETENTION_DAYS } from "../../config.js";
import { readConfiguredEveTurnOutcome } from "../sessions/workflow-turn-outcome.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { hasPendingReviewWrite, lockReviewAttempt, requireReviewSources, reviewAttemptHasWrites } from "./memory-review-attempt.js";
import { blockPartialReviewAttempt } from "./memory-review-model-recovery.js";
import { recordOperationalIncident } from "../operational-incidents/owner-alerts.js";
import { isDatabaseUnavailable } from "../database-errors.js";
import { terminalizeApplicationSession } from "./memory-review-session-terminal.js";

export async function reconcileMemoryReviewExecutions(readStatus: (sessionId: string,turnId: string) => Promise<string | null> = readConfiguredEveTurnOutcome): Promise<void> {
  const candidates = await database().query<{ id: string; eve_session_id: string; eve_turn_id: string; infrastructure_recovery_attempts: number; model_recovery_generation: number }>(
    `SELECT id,eve_session_id,eve_turn_id,infrastructure_recovery_attempts,model_recovery_generation FROM memory_review_batches
     WHERE recovery_protocol=1 AND batch_kind='background' AND status='running' AND eve_turn_id IS NOT NULL
       AND updated_at<now()-interval '1 minute' ORDER BY updated_at,id LIMIT 10`);
  for (const candidate of candidates.rows) {
    try {
    const status = await readStatus(candidate.eve_session_id,candidate.eve_turn_id);
    if (status === "completed") {
      await memoryReviewRepository.completeBatch({ batchId: candidate.id, eveSessionId: candidate.eve_session_id,
        eveTurnId: candidate.eve_turn_id, completedAt: new Date() });
      continue;
    }
    if (status !== "failed" && status !== "cancelled") {
      await database().query("UPDATE memory_review_batches SET updated_at=now() WHERE id=$1 AND eve_session_id=$2 AND status='running'", [candidate.id,candidate.eve_session_id]);
      if (status !== "running") await recordOperationalIncident({ key: `memory-review:${candidate.id}:outcome:${candidate.model_recovery_generation}`,
        code: "AGENT_MEMORY_REVIEW_OUTCOME_UNCONFIRMED",summary: "Не удалось прочитать подтверждение результата проверки памяти. Сообщения сохранены; проверка состояния продолжится автоматически.",
        context: { batchId: candidate.id,eveSessionId: candidate.eve_session_id } });
      continue;
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const batch = await lockReviewAttempt(client, candidate.id);
      if (!batch || batch.status !== "running" || batch.eve_session_id !== candidate.eve_session_id || batch.eve_turn_id !== candidate.eve_turn_id) {
        await client.query("COMMIT"); continue;
      }
      await requireReviewSources(client, batch);
      if (await hasPendingReviewWrite(client, batch.id)) { await client.query("COMMIT"); continue; }
      if (await reviewAttemptHasWrites(client, batch)) {
        await blockPartialReviewAttempt(client, batch, "AGENT_MEMORY_REVIEW_TERMINAL_RECONCILED", new Date());
      } else if (status === "failed" && candidate.infrastructure_recovery_attempts === 0) {
        // The native task is terminal; its restricted tool surface could only write the checked memory stores.
        await client.query(`UPDATE conversation_sessions SET retired_at=now(),delete_after=now()+$2*interval '1 day',
          task_state='failed',pending_operation=false,memory_review_batch_id=NULL WHERE id=$1`, [batch.application_session_id, SESSION_RETENTION_DAYS]);
        await client.query("DELETE FROM memory_turn_source_sets WHERE memory_review_batch_id=$1", [batch.id]);
        await client.query(`UPDATE memory_review_batches SET status='pending',model_recovery_generation=model_recovery_generation+1,
          infrastructure_recovery_attempts=1,application_session_id=NULL,eve_session_id=NULL,eve_turn_id=NULL,
          started_at=NULL,completed_at=NULL,diagnostic_code=NULL,updated_at=now() WHERE id=$1`, [batch.id]);
        await client.query(`INSERT INTO audit_events(family_id,event_type,subject_id,metadata)
          SELECT family_id,'memory_review.model_recovered',$2,jsonb_build_object('causeCode','AGENT_MEMORY_REVIEW_TERMINAL_RECONCILED',
          'previousEveSessionId',$3::text,'previousEveTurnId',$4::text) FROM application_conversations WHERE id=$1`,
        [batch.conversation_id,batch.id,batch.eve_session_id,batch.eve_turn_id]);
      } else {
        if (batch.application_session_id && batch.eve_session_id) await terminalizeApplicationSession(client,{
          applicationSessionId: batch.application_session_id,eveSessionId: batch.eve_session_id,completedAt: new Date(),outcome: "failed",
        });
        await client.query("DELETE FROM memory_turn_source_sets WHERE memory_review_batch_id=$1", [batch.id]);
        await client.query(`UPDATE memory_review_batches SET status='failed',diagnostic_code='AGENT_MEMORY_REVIEW_EXECUTION_STOPPED',
          completed_at=now(),updated_at=now() WHERE id=$1`, [batch.id]);
        await recordOperationalIncident({ key: `memory-review:${batch.id}:stopped`, code: "AGENT_MEMORY_REVIEW_EXECUTION_STOPPED",
          summary: "Проверка памяти остановлена. Исходные сообщения сохранены; требуется проверка результата.", context: { batchId: batch.id } }, client);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw error;
      console.error(JSON.stringify({ code: "AGENT_MEMORY_REVIEW_RECONCILIATION_FAILED",batchId: candidate.id,
        error: error instanceof Error ? error.message : String(error) }));
      await database().query("UPDATE memory_review_batches SET updated_at=now() WHERE id=$1 AND eve_session_id=$2 AND status='running'", [candidate.id,candidate.eve_session_id]);
      await recordOperationalIncident({ key: `memory-review:${candidate.id}:reconciliation:${candidate.model_recovery_generation}`,
        code: "AGENT_MEMORY_REVIEW_RECONCILIATION_FAILED",summary: "Не удалось проверить результат одного пакета памяти. Его сообщения сохранены; остальные пакеты продолжают обработку.",
        context: { batchId: candidate.id,eveSessionId: candidate.eve_session_id } });
    }
  }
}
