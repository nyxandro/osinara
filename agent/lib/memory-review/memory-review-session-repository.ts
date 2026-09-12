/**
 * Dedicated application-session storage for one-shot memory-review turns.
 *
 * Export:
 * - `memoryReviewSessionRepository`: creates and retires explicitly batch-linked Eve sessions.
 */
import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { PreparedSession } from "../sessions/session-repository.js";
import type { MemoryReviewClaim } from "./memory-review-repository.js";
import { modelProviderConfig } from "../model-provider-config.js";
import { modelRouteKey } from "../model-route.js";
import { reviewContinuationToken } from "./memory-review-session.js";

export const memoryReviewSessionRepository = {
  async prepare(batch: MemoryReviewClaim, now: Date): Promise<PreparedSession> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const attempt = await client.query<{ model_recovery_generation: number }>(
        `UPDATE memory_review_batches SET model_route_key = $3
         WHERE id = $1 AND status = 'leased' AND lease_token = $2 RETURNING model_recovery_generation`,
        [batch.batchId, batch.leaseToken, modelRouteKey(modelProviderConfig.agent.transport, modelProviderConfig.agent.models.primary.id)],
      );
      if (!attempt.rows[0]) throw new AppError("AGENT_MEMORY_REVIEW_LEASE_STALE", "Попытка проверки памяти уже неактуальна");
      const generation = attempt.rows[0].model_recovery_generation;
      const continuationToken = reviewContinuationToken(batch.batchId, generation);
      const result = await client.query<{ id: string; thread_id: string }>(
        `INSERT INTO conversation_sessions
           (thread_id, generation, family_id, group_id, scope, kind, task_state,
             telegram_forum_topic_id, conversation_key, continuation_token,
             started_at, last_activity_at, memory_review_batch_id)
          VALUES (gen_random_uuid(), $8, $1, $2, $3, 'proactive', 'running', $4,
                  $9, $5, $6, $6, $7)
          ON CONFLICT (memory_review_batch_id) WHERE memory_review_batch_id IS NOT NULL
          DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at
            WHERE conversation_sessions.retired_at IS NULL
              AND conversation_sessions.kind = 'proactive'
              AND conversation_sessions.eve_session_id IS NULL
          RETURNING id, thread_id`,
        [batch.familyId, batch.groupId, batch.scope, batch.messageThreadId,
          continuationToken, now, batch.batchId, generation, `memory-review:${batch.batchId}`],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(
        "AGENT_MEMORY_REVIEW_SESSION_CREATE_FAILED",
        "Не удалось создать контекст проверки памяти",
      );
      await client.query("COMMIT");
      return {
        continuationToken,
        generation,
        id: row.id,
        rotated: false,
        sandboxSessionId: row.thread_id,
      };
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  },

  async retireUnstarted(
    batch: MemoryReviewClaim,
    applicationSessionId: string,
  ): Promise<void> {
    const result = await database().query(
      `UPDATE conversation_sessions
           SET pending_operation = false, task_state = 'failed', retired_at = now(),
               memory_review_batch_id = NULL, continuation_token = 'retired-memory-review:' || id,
              delete_after = now() + $2 * interval '1 day'
        WHERE id = $1 AND retired_at IS NULL AND kind = 'proactive'
          AND memory_review_batch_id = $3 AND eve_session_id IS NULL
          AND EXISTS (
            SELECT 1 FROM memory_review_batches AS batch
             WHERE batch.id = $3 AND batch.status = 'leased' AND batch.lease_token = $4
               AND batch.application_session_id IS NULL
          )`,
      [applicationSessionId, SESSION_RETENTION_DAYS, batch.batchId, batch.leaseToken],
    );
    // A lost lease transfers ownership of the reused session; the stale worker must not retire it.
    if (result.rowCount === 0) return;
  },
};
