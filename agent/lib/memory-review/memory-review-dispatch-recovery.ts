/** A missing turn binding is recoverable only after fencing the exact old application session. */
import type { PoolClient } from "pg";
import { SESSION_RETENTION_DAYS } from "../../config.js";
import { requireReviewSources, reviewAttemptHasWrites, type ReviewAttempt } from "./memory-review-attempt.js";

export async function recoverReviewDispatches(client: PoolClient, now: Date): Promise<void> {
  const candidates = await client.query<ReviewAttempt>(`SELECT batch.* FROM memory_review_batches batch
    WHERE batch.batch_kind='background' AND batch.recovery_protocol=1 AND batch.eve_turn_id IS NULL
      AND ((batch.status='dispatching' AND batch.lease_expires_at <= $1) OR
           (batch.status='running' AND batch.started_at <= $1::timestamptz-interval '1 minute'))
    ORDER BY batch.created_at,batch.id FOR UPDATE OF batch SKIP LOCKED LIMIT 10`, [now]);
  for (const batch of candidates.rows) {
    await requireReviewSources(client, batch);
    if (await reviewAttemptHasWrites(client, batch)) continue;
    if (batch.application_session_id !== null) {
      const session = await client.query(`SELECT id FROM conversation_sessions WHERE id=$1 FOR UPDATE SKIP LOCKED`, [batch.application_session_id]);
      if (session.rowCount !== 1) continue;
      await client.query(`UPDATE conversation_sessions SET retired_at=$2,delete_after=$2::timestamptz+$3*interval '1 day',
        task_state='failed',pending_operation=false,memory_review_batch_id=NULL WHERE id=$1`, [batch.application_session_id, now, SESSION_RETENTION_DAYS]);
    }
    // bindEveTurn uses the same batch row and exact application_session_id before any model/tool work.
    await client.query(`UPDATE memory_review_batches SET status='pending',application_session_id=NULL,eve_session_id=NULL,
      eve_turn_id=NULL,lease_token=NULL,lease_expires_at=NULL,started_at=NULL,completed_at=NULL,diagnostic_code=NULL,
      model_recovery_generation=model_recovery_generation+1,updated_at=$2 WHERE id=$1`, [batch.id, now]);
    await client.query(`INSERT INTO audit_events(family_id,event_type,subject_id,metadata)
      SELECT family_id,'memory_review.model_recovered',$2,jsonb_build_object('causeCode','AGENT_MEMORY_REVIEW_HANDOFF_RECOVERED',
        'previousSessionId',$3::text,'previousEveSessionId',$4::text,'previousEveTurnId',$5::text)
      FROM application_conversations WHERE id=$1`, [batch.conversation_id, batch.id, batch.application_session_id, batch.eve_session_id, batch.eve_turn_id]);
  }
}
