/**
 * Failure and ambiguity transitions for memory-review dispatch.
 *
 * Exports:
 * - `terminalizeStaleMemoryReviewBatches`: exact timeout classification inside a claim transaction.
 * - `memoryReviewDispatchTerminalRepository`: bounded retry and terminal background/interactive states.
 */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { isRecoverableModelCode } from "../model-failure.js";
import { failBackgroundReview } from "./memory-review-model-recovery.js";
import {
  MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE,
  MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS,
  MEMORY_REVIEW_MAX_SAFE_RECOVERY_ATTEMPTS,
} from "./memory-review-config.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";
import type { MemoryReviewClaim } from "./memory-review-repository.js";
import {
  resolveAbandonedReviewBatch,
  terminalizeAbandonedReviewTurns,
} from "./memory-review-terminal-repository.js";

const TURN_NEVER_STARTED = "AGENT_MEMORY_REVIEW_TURN_NEVER_STARTED";
const DISPATCH_TIMEOUT_AMBIGUOUS = "AGENT_MEMORY_REVIEW_DISPATCH_TIMEOUT_AMBIGUOUS";

async function terminalizeStaleInteractiveBatches(client: PoolClient, now: Date): Promise<void> {
  // A batch whose turn never reached Eve carries no binding at all, so it provably wrote nothing:
  // the turn was cancelled or died before `turn.started`. The previous ending marked it ambiguous,
  // which is a permanent freeze of the whole lane — that is what stopped the group on 2026-09-04.
  const stale = await client.query<{
    application_session_id: string | null;
    id: string;
    lane_id: string;
  }>(
    `SELECT id, lane_id, application_session_id FROM memory_review_batches
      WHERE batch_kind = 'interactive' AND status = 'running' AND eve_session_id IS NULL
        AND started_at <= $1::timestamptz - $2::double precision * interval '1 millisecond'
      ORDER BY started_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT $3`,
    [now, MEMORY_REVIEW_INTERACTIVE_START_TIMEOUT_MILLISECONDS,
      MEMORY_REVIEW_ABANDONED_TURN_BATCH_SIZE],
  );
  for (const batch of stale.rows) {
    const outcome = await resolveAbandonedReviewBatch(client, {
      applicationSessionId: batch.application_session_id,
      batchId: batch.id,
      diagnosticCode: TURN_NEVER_STARTED,
      eveSessionId: null,
      eveTurnId: null,
      laneId: batch.lane_id,
      notifyOwner: true,
      now,
    });
    console.error(JSON.stringify({
      batchId: batch.id,
      code: TURN_NEVER_STARTED,
      laneId: batch.lane_id,
      outcome,
    }));
  }
}

async function terminalizeStaleDispatchingBatches(client: PoolClient, now: Date): Promise<void> {
  // A handoff that outlives its lease may already have reached Eve, so it is never auto-retried.
  const stale = await client.query<{ application_session_id: string; id: string }>(
    `UPDATE memory_review_batches
        SET status = 'ambiguous', diagnostic_code = $2,
            completed_at = $1, updated_at = $1, lease_token = NULL, lease_expires_at = NULL
      WHERE batch_kind = 'background' AND status = 'dispatching' AND lease_expires_at <= $1
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
  await terminalizeStaleInteractiveBatches(client, now);
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
        // The only retry happens before Eve handoff and is explicit in both batch state and audit.
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

  async markSessionAmbiguous(input: {
    batchId: string;
    diagnosticCode: string;
    eveSessionId: string;
  }): Promise<void> {
    if (isRecoverableModelCode(input.diagnosticCode)) {
      await failBackgroundReview(input);
      return;
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Match recovery/writer fencing order: batch first, then the exact application session.
      await client.query("SELECT id FROM memory_review_batches WHERE id = $1 FOR UPDATE", [input.batchId]);
      const session = await client.query<{ id: string }>(
        `SELECT app_session.id
           FROM conversation_sessions AS app_session
          WHERE app_session.id = (
            SELECT application_session_id FROM memory_review_batches WHERE id = $1
          )
            AND (app_session.eve_session_id IS NULL OR app_session.eve_session_id = $2)
          FOR UPDATE`,
        [input.batchId, input.eveSessionId],
      );
      if (!session.rows[0]) {
        await client.query("ROLLBACK");
        return;
      }
      const batch = await client.query<{ application_session_id: string }>(
        `UPDATE memory_review_batches AS batch
            SET status = 'ambiguous', eve_session_id = coalesce(batch.eve_session_id, $2),
                diagnostic_code = $3, completed_at = now(), updated_at = now(),
                lease_token = NULL, lease_expires_at = NULL
          WHERE batch.id = $1 AND batch.batch_kind = 'background'
            AND batch.application_session_id = $4
            AND batch.status IN ('dispatching', 'running')
            AND (batch.eve_session_id IS NULL OR batch.eve_session_id = $2)
          RETURNING batch.application_session_id`,
        [input.batchId, input.eveSessionId, input.diagnosticCode, session.rows[0].id],
      );
      const applicationSessionId = batch.rows[0]?.application_session_id;
      if (!applicationSessionId) {
        await client.query("ROLLBACK");
        return;
      }
      await client.query(
        `UPDATE conversation_sessions
            SET pending_operation = false, task_state = 'failed', eve_session_id = $2,
                retired_at = now(), delete_after = now() + $3 * interval '1 day'
          WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
            AND memory_review_batch_id = $4`,
        [applicationSessionId, input.eveSessionId, SESSION_RETENTION_DAYS, input.batchId],
      );
      await enqueueMemoryReviewOwnerAlert(client, input.batchId, input.diagnosticCode);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markInteractiveSessionAmbiguous(input: {
    continuationToken: string;
    diagnosticCode: string;
    eveSessionId: string;
  }): Promise<"recorded" | "stale" | null> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      // Serialize exact-root classification with every bind/rotation of the canonical session.
      const session = await client.query<{
        eve_session_id: string | null;
        id: string;
        retired_at: Date | null;
      }>(
        `SELECT id, eve_session_id, retired_at FROM conversation_sessions
          WHERE continuation_token = $1 FOR UPDATE`,
        [input.continuationToken],
      );
      const current = session.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return null;
      }
      if (current.eve_session_id !== input.eveSessionId) {
        await client.query("ROLLBACK");
        return "stale";
      }
      // A failed chat session leaves its review batch behind. The previous `ambiguous` ending
      // blocked the lane at that place forever, and mid-chain it also collided with the next
      // prepared turn on `(lane_id, predecessor_sequence)`. Provenance decides here as everywhere.
      const result = await client.query<{ batch_id: string; eve_turn_id: string | null; lane_id: string }>(
        `SELECT id AS batch_id, lane_id, eve_turn_id FROM memory_review_batches
          WHERE application_session_id = $2 AND eve_session_id = $1
            AND batch_kind = 'interactive' AND status = 'running' FOR UPDATE`,
        [input.eveSessionId, current.id],
      );
      const failed = result.rows[0];
      if (failed) {
        await resolveAbandonedReviewBatch(client, {
          applicationSessionId: null,
          batchId: failed.batch_id,
          diagnosticCode: input.diagnosticCode,
          eveSessionId: input.eveSessionId,
          eveTurnId: failed.eve_turn_id,
          laneId: failed.lane_id,
          notifyOwner: true,
          now: new Date(),
        });
      }
      if (result.rowCount === 0) {
        const review = await client.query(
          `SELECT 1 FROM memory_review_batches
            WHERE application_session_id = $1 AND batch_kind = 'interactive'`,
          [current.id],
        );
        if (!review.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
      }
      await client.query(
        `UPDATE conversation_sessions
            SET pending_operation = false, rotation_requested_at = now()
          WHERE id = $1 AND eve_session_id = $2 AND retired_at IS NULL`,
        [current.id, input.eveSessionId],
      );
      await client.query("COMMIT");
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
