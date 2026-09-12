/** Shared proofs and fencing for a background review attempt and its memory writes. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import type { CreateMemoryInput } from "../memory-record.js";

export interface ReviewAttempt {
  id: string;
  lane_id: string;
  conversation_id: string;
  batch_kind: "background" | "interactive";
  status: string;
  application_session_id: string | null;
  eve_session_id: string | null;
  eve_turn_id: string | null;
  model_route_key: string | null;
  model_recovery_generation: number;
  diagnostic_code: string | null;
  source_count: number;
  from_sequence: string;
  through_sequence: string;
}

export async function lockReviewAttempt(client: PoolClient, id: string): Promise<ReviewAttempt | null> {
  return (await client.query<ReviewAttempt>(
    "SELECT * FROM memory_review_batches WHERE id = $1 FOR UPDATE", [id],
  )).rows[0] ?? null;
}

export async function isRetiredReviewAttempt(client: PoolClient, input: {
  batchId: string; eveSessionId: string; eveTurnId: string;
}): Promise<boolean> {
  return (await client.query(
    `SELECT 1 FROM audit_events WHERE subject_id = $1 AND event_type = 'memory_review.model_recovered'
      AND metadata->>'previousEveSessionId' = $2 AND metadata->>'previousEveTurnId' = $3 LIMIT 1`,
    [input.batchId, input.eveSessionId, input.eveTurnId],
  )).rowCount === 1;
}

export async function reviewAttemptHasWrites(client: PoolClient, batch: ReviewAttempt): Promise<boolean> {
  const result = await client.query<{ wrote: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM memory_items_all WHERE source = $1)
       OR EXISTS (SELECT 1 FROM memory_mutation_operations WHERE eve_session_id = $2) AS wrote`,
    [`eve:${batch.eve_session_id}:${batch.eve_turn_id}`, batch.eve_session_id],
  );
  return result.rows[0]!.wrote;
}

export async function requireReviewSources(client: PoolClient, batch: ReviewAttempt): Promise<void> {
  const result = await client.query<{ count: number; first: string; last: string; intact: boolean }>(
    `SELECT count(*)::int AS count, min(source.timeline_sequence)::text AS first,
       max(source.timeline_sequence)::text AS last,
       bool_and(source.conversation_id = $2 AND message.conversation_id = $2
         AND source.timeline_sequence = message.sequence_id
         AND message.actor_kind IN ('user', 'telegram_bot')
         AND message.message_thread_id IS NOT DISTINCT FROM lane.message_thread_id) AS intact
     FROM memory_review_batch_sources source
     JOIN telegram_group_messages message ON message.id = source.timeline_entry_id
     JOIN memory_review_lanes lane ON lane.id = $3 WHERE source.batch_id = $1`,
    [batch.id, batch.conversation_id, batch.lane_id],
  );
  const row = result.rows[0]!;
  if (row.count !== batch.source_count || row.first !== batch.from_sequence ||
      row.last !== batch.through_sequence || row.intact !== true) {
    throw new AppError("AGENT_MEMORY_REVIEW_RECOVERY_SOURCES_INVALID", "Источники проверки памяти изменились. Требуется проверка администратора");
  }
}

export async function hasPendingReviewWrite(client: PoolClient, batchId: string): Promise<boolean> {
  return (await client.query<{ pending: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM memory_thread_creation_attempts attempt
       JOIN memory_review_batch_sources source ON source.timeline_entry_id = attempt.timeline_entry_id
         AND source.conversation_id = attempt.conversation_id
       WHERE source.batch_id = $1 AND attempt.status = 'pending' AND attempt.lease_expires_at > now()) AS pending`,
    [batchId],
  )).rows[0]!.pending;
}

export async function fenceReviewMemoryWrite(client: PoolClient, input: CreateMemoryInput): Promise<void> {
  if (input.memoryReviewBatchId === undefined) return;
  // Held until commit: recovery cannot prove zero writes and then race an old writer.
  const batch = await client.query(
    `SELECT 1 FROM memory_review_batches batch
       JOIN conversation_sessions session ON session.id = batch.application_session_id
     WHERE batch.id = $1 AND batch.batch_kind = 'background' AND batch.status = 'running'
       AND batch.eve_session_id = $2 AND batch.eve_turn_id = $3 AND session.retired_at IS NULL
       AND session.eve_session_id = $2 FOR SHARE OF batch`,
    [input.memoryReviewBatchId, input.provenance?.sessionId, input.provenance?.turnId],
  );
  if (batch.rowCount !== 1) throw new AppError(
    "AGENT_MEMORY_REVIEW_ATTEMPT_STALE", "Эта попытка проверки памяти уже завершена. Повторная запись отклонена",
  );
}
