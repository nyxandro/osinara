/**
 * Failure and ambiguity transitions for memory-review dispatch.
 *
 * Exports:
 * - `terminalizeStaleMemoryReviewBatches`: exact timeout classification inside a claim transaction.
 * - `memoryReviewDispatchTerminalRepository`: bounded retry and terminal background states.
 */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS } from "./memory-review-config.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";
import type { MemoryReviewClaim } from "./memory-review-repository.js";
import { terminalizeAbandonedReviewTurns } from "./memory-review-terminal-repository.js";

const DISPATCH_TIMEOUT_AMBIGUOUS = "AGENT_MEMORY_REVIEW_DISPATCH_TIMEOUT_AMBIGUOUS";

async function terminalizeStaleDispatchingBatches(client: PoolClient, now: Date): Promise<void> {
  // A handoff that outlives its lease may already have started its turn, so it is never auto-retried.
  const stale = await client.query<{ application_session_id: string; id: string }>(
    `UPDATE memory_review_batches
        SET status = 'ambiguous', diagnostic_code = $2,
            completed_at = $1, updated_at = $1, lease_token = NULL, lease_expires_at = NULL
       WHERE batch_kind = 'background' AND status = 'dispatching' AND lease_expires_at <= $1
         AND recovery_protocol=0
      RETURNING id, application_session_id`,
    [now, DISPATCH_TIMEOUT_AMBIGUOUS],
  );
  for (const batch of stale.rows) {
    await client.query(
      `UPDATE conversation_sessions
          SET pending_operation = false, task_state = 'failed', retired_at = $2::timestamptz,
              delete_after = $2::timestamptz + $3 * interval '1 day'
        WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
          AND memory_review_batch_id = $4`,
      [batch.application_session_id, now, SESSION_RETENTION_DAYS, batch.id],
    );
    await enqueueMemoryReviewOwnerAlert(client, batch.id, DISPATCH_TIMEOUT_AMBIGUOUS);
  }
}

export async function terminalizeStaleMemoryReviewBatches(
  client: PoolClient,
  now: Date,
): Promise<void> {
  await terminalizeStaleDispatchingBatches(client, now);
  await terminalizeAbandonedReviewTurns(client, now);
}

export const memoryReviewDispatchTerminalRepository = {
  async failClaim(
    batch: MemoryReviewClaim,
    diagnosticCode: string,
  ): Promise<"failed" | "retry_scheduled"> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        recovery_attempts: number;
        status: "failed" | "pending";
      }>(
        `UPDATE memory_review_batches
            SET status = CASE
                  WHEN recovery_attempts < $4 THEN 'pending'::memory_review_batch_status
                  ELSE 'failed'::memory_review_batch_status
                END,
                recovery_attempts = CASE
                  WHEN recovery_attempts < $4 THEN recovery_attempts + 1
                  ELSE recovery_attempts
                END,
                last_recovery_diagnostic_code = CASE
                  WHEN recovery_attempts < $4 THEN $3::text
                  ELSE last_recovery_diagnostic_code
                END,
                last_recovered_at = CASE
                  WHEN recovery_attempts < $4 THEN now()
                  ELSE last_recovered_at
                END,
                diagnostic_code = CASE WHEN recovery_attempts < $4 THEN NULL ELSE $3::text END,
                completed_at = CASE WHEN recovery_attempts < $4 THEN NULL ELSE now() END,
                updated_at = now(), lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1 AND status = 'leased' AND lease_token = $2
          RETURNING status::text, recovery_attempts`,
        [batch.batchId, batch.leaseToken, diagnosticCode,
          MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS],
      );
      const transition = result.rows[0];
      if (!transition) throw new AppError(
        "AGENT_MEMORY_REVIEW_FAILURE_STATE_INVALID",
        "Не удалось сохранить ошибку проверки памяти",
      );
      if (transition.status === "pending") {
        // The only retry happens before the hand-off and is explicit in both batch state and audit.
        await client.query(
          `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
           VALUES ($1, 'memory_review.retry_scheduled', $2,
                   jsonb_build_object('diagnosticCode', $3::text, 'recoveryAttempt', $4::integer))`,
          [batch.familyId, batch.batchId, diagnosticCode, transition.recovery_attempts],
        );
      } else {
        await enqueueMemoryReviewOwnerAlert(client, batch.batchId, diagnosticCode);
      }
      await client.query("COMMIT");
      return transition.status === "pending" ? "retry_scheduled" : "failed";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markAmbiguous(
    batch: MemoryReviewClaim,
    diagnosticCode: string,
    applicationSessionId: string,
  ): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE memory_review_batches SET status = 'ambiguous', diagnostic_code = $3,
                 application_session_id = coalesce(application_session_id, $4),
                 completed_at = now(), updated_at = now(), lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1 AND status IN ('leased', 'dispatching') AND lease_token = $2
             AND (application_session_id IS NULL OR application_session_id = $4)`,
        [batch.batchId, batch.leaseToken, diagnosticCode, applicationSessionId],
      );
      if (result.rowCount !== 1) throw new AppError(
        "AGENT_MEMORY_REVIEW_AMBIGUOUS_STATE_INVALID",
        "Не удалось сохранить неоднозначный результат проверки памяти",
      );
      await client.query(
        `UPDATE conversation_sessions
            SET pending_operation = false, task_state = 'failed', retired_at = now(),
                delete_after = now() + $2 * interval '1 day'
          WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
            AND memory_review_batch_id = $3`,
        [applicationSessionId, SESSION_RETENTION_DAYS, batch.batchId],
      );
      await enqueueMemoryReviewOwnerAlert(client, batch.batchId, diagnosticCode);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
