/** Model failures wait durably; a new successful call releases exactly one fresh attempt. */
import type { PoolClient } from "pg";
import { database } from "../database.js";
import { AppError } from "../app-error.js";
import { isRecoverableModelCode, type RecoverableModelCode } from "../model-failure.js";
import { MEMORY_REVIEW_DISPATCH_BATCH_SIZE } from "./memory-review-config.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";
import { terminalizeApplicationSession } from "./memory-review-session-terminal.js";
import { hasPendingReviewWrite, lockReviewAttempt, requireReviewSources, reviewAttemptHasWrites, type ReviewAttempt } from "./memory-review-attempt.js";

export const REVIEW_WAITING_MODEL = "AGENT_MEMORY_REVIEW_WAITING_MODEL";
export const REVIEW_PARTIAL_RESULT = "AGENT_MEMORY_REVIEW_PARTIAL_RESULT";

async function audit(client: PoolClient, batch: ReviewAttempt, event: string, metadata: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     SELECT family_id, $2, $3, $4::jsonb FROM application_conversations WHERE id = $1`,
    [batch.conversation_id, event, batch.id, JSON.stringify(metadata)],
  );
}

export async function blockPartialReviewAttempt(client: PoolClient, batch: ReviewAttempt, causeCode: string, now: Date): Promise<void> {
  if (batch.application_session_id && batch.eve_session_id) await terminalizeApplicationSession(client, {
    applicationSessionId: batch.application_session_id, eveSessionId: batch.eve_session_id, completedAt: now, outcome: "failed",
  });
  await client.query(`UPDATE memory_review_batches SET status = 'failed', diagnostic_code = $2,
    completed_at = $3, updated_at = $3, lease_token = NULL, lease_expires_at = NULL,
    waiting_since = NULL, waiting_success_version = NULL WHERE id = $1`, [batch.id, REVIEW_PARTIAL_RESULT, now]);
  await enqueueMemoryReviewOwnerAlert(client, batch.id, REVIEW_PARTIAL_RESULT);
  await audit(client, batch, "memory_review.partial_result", { causeCode, generation: batch.model_recovery_generation,
    eveSessionId: batch.eve_session_id, eveTurnId: batch.eve_turn_id });
}

export async function recordReviewModelWait(
  client: PoolClient, batch: ReviewAttempt, code: RecoverableModelCode, now: Date,
): Promise<"waiting" | "blocked"> {
  if (!batch.model_route_key || !batch.eve_session_id || !batch.eve_turn_id || !batch.application_session_id) {
    throw new AppError("AGENT_MEMORY_REVIEW_RECOVERY_CONTEXT_MISSING", "Не удалось подтвердить исполнение проверки памяти");
  }
  await requireReviewSources(client, batch);
  const wrote = await reviewAttemptHasWrites(client, batch);
  if (wrote) {
    await blockPartialReviewAttempt(client, batch, code, now);
    return "blocked";
  }
  await terminalizeApplicationSession(client, { applicationSessionId: batch.application_session_id,
    eveSessionId: batch.eve_session_id, completedAt: now, outcome: "failed" });
  // Zero explicitly means no successful call has yet been observed for this connection.
  await client.query(`UPDATE memory_review_batches SET status = 'waiting_model', diagnostic_code = $2,
    completed_at = NULL, updated_at = $3, waiting_since = $3,
    waiting_success_version = coalesce((SELECT success_version FROM model_availability WHERE route_key = $4), 0),
    lease_token = NULL, lease_expires_at = NULL WHERE id = $1`, [batch.id, code, now, batch.model_route_key]);
  await enqueueMemoryReviewOwnerAlert(client, batch.id, REVIEW_WAITING_MODEL);
  await audit(client, batch, "memory_review.waiting_model", {
    causeCode: code, modelRouteKey: batch.model_route_key, generation: batch.model_recovery_generation,
    eveSessionId: batch.eve_session_id, eveTurnId: batch.eve_turn_id,
  });
  return "waiting";
}

export async function failBackgroundReview(input: {
  batchId: string; diagnosticCode: string; eveSessionId: string; eveTurnId?: string;
}): Promise<"waiting" | "blocked" | "replayed" | null> {
  if (!input.diagnosticCode) throw new AppError("AGENT_MEMORY_REVIEW_DIAGNOSTIC_MISSING", "Не сохранена причина ошибки проверки памяти");
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const batch = await lockReviewAttempt(client, input.batchId);
    if (!batch || batch.batch_kind !== "background") { await client.query("COMMIT"); return null; }
    if (batch.eve_session_id !== input.eveSessionId || input.eveTurnId !== undefined && batch.eve_turn_id !== input.eveTurnId ||
        !["running", "dispatching"].includes(batch.status)) {
      await client.query("COMMIT"); return "replayed";
    }
    const now = new Date();
    let result: "waiting" | "blocked";
    if (isRecoverableModelCode(input.diagnosticCode)) {
      result = await recordReviewModelWait(client, batch, input.diagnosticCode, now);
    } else if (await reviewAttemptHasWrites(client, batch)) {
      await blockPartialReviewAttempt(client, batch, input.diagnosticCode, now);
      result = "blocked";
    } else {
      // An unknown background error must not silently release/replay or skip its sources.
      if (batch.application_session_id && batch.eve_session_id) await terminalizeApplicationSession(client, {
        applicationSessionId: batch.application_session_id, eveSessionId: batch.eve_session_id, completedAt: now, outcome: "failed",
      });
      await client.query(`UPDATE memory_review_batches SET status = 'failed', diagnostic_code = $2,
        completed_at = $3, updated_at = $3, lease_token = NULL, lease_expires_at = NULL WHERE id = $1`,
      [batch.id, input.diagnosticCode, now]);
      await enqueueMemoryReviewOwnerAlert(client, batch.id, input.diagnosticCode);
      await audit(client, batch, "memory_review.failed", { causeCode: input.diagnosticCode,
        eveSessionId: batch.eve_session_id, eveTurnId: batch.eve_turn_id });
      result = "blocked";
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
}

/** Called under dispatcher's lane locks; skip a batch already owned by a terminal handler. */
export async function recoverModelWaitingReviews(client: PoolClient, now: Date): Promise<void> {
  const candidates = await client.query<ReviewAttempt & { success_version: string }>(
    `SELECT batch.*, health.success_version FROM memory_review_batches batch
     JOIN model_availability health ON health.route_key = batch.model_route_key
     JOIN memory_review_lanes lane ON lane.id = batch.lane_id
     WHERE batch.status = 'waiting_model' AND batch.predecessor_sequence = lane.processed_through_sequence
       AND health.success_version > batch.waiting_success_version AND health.observed_at > batch.waiting_since
     ORDER BY batch.waiting_since, batch.id FOR UPDATE OF batch SKIP LOCKED LIMIT $1`,
    [MEMORY_REVIEW_DISPATCH_BATCH_SIZE],
  );
  for (const batch of candidates.rows) {
    if (batch.application_session_id !== null) {
      // Retention locks the session before its FK clears the batch reference. Never wait in the
      // opposite order: let deletion finish, then recover on the next tick with the same signal.
      const session = await client.query<{ retired_at: Date | null; eve_session_id: string | null }>(
        "SELECT retired_at, eve_session_id FROM conversation_sessions WHERE id = $1 FOR UPDATE SKIP LOCKED", [batch.application_session_id]);
      if (!session.rows[0]?.retired_at || session.rows[0].eve_session_id !== batch.eve_session_id) continue;
    }
    if (!batch.diagnostic_code || !isRecoverableModelCode(batch.diagnostic_code)) throw new AppError(
      "AGENT_MEMORY_REVIEW_RECOVERY_REASON_INVALID", "Не подтверждена причина ожидания модели",
    );
    try {
      await requireReviewSources(client, batch);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "AGENT_MEMORY_REVIEW_RECOVERY_SOURCES_INVALID") throw error;
      await client.query(`UPDATE memory_review_batches SET status = 'failed', diagnostic_code = $2,
        completed_at = $3, updated_at = $3, waiting_since = NULL, waiting_success_version = NULL WHERE id = $1`,
      [batch.id, error.code, now]);
      await enqueueMemoryReviewOwnerAlert(client, batch.id, error.code);
      continue;
    }
    if (await reviewAttemptHasWrites(client, batch)) {
      await blockPartialReviewAttempt(client, batch, batch.diagnostic_code, now);
      continue;
    }
    if (await hasPendingReviewWrite(client, batch.id)) continue;
    if (batch.application_session_id !== null) {
      await client.query("UPDATE conversation_sessions SET memory_review_batch_id = NULL WHERE id = $1", [batch.application_session_id]);
    }
    await client.query("DELETE FROM memory_turn_source_sets WHERE memory_review_batch_id = $1", [batch.id]);
    await client.query(`UPDATE memory_review_batches SET status = 'pending', model_recovery_generation = model_recovery_generation + 1,
      application_session_id = NULL, eve_session_id = NULL, eve_turn_id = NULL, started_at = NULL,
      diagnostic_code = NULL, completed_at = NULL, waiting_since = NULL, waiting_success_version = NULL, updated_at = $2
      WHERE id = $1`, [batch.id, now]);
    await audit(client, batch, "memory_review.model_recovered", {
      causeCode: batch.diagnostic_code, generation: batch.model_recovery_generation + 1,
      successVersion: batch.success_version, modelRouteKey: batch.model_route_key,
      previousSessionId: batch.application_session_id, previousEveSessionId: batch.eve_session_id,
      previousEveTurnId: batch.eve_turn_id,
    });
  }
}
