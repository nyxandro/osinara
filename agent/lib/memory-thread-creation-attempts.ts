/**
 * Durable server-side memory-thread creation retry state machine.
 *
 * Exports:
 * - `replayMemoryThreadCreationAttempt`: returns a durable candidate or active-call error before E5.
 * - `reserveMemoryThreadCreationAttempt`: atomically reserves the initial call or one refined retry.
 * - `requireMemoryThreadCreationReservation`: locks and validates a reservation before claim writes.
 * - `recordMemoryThreadCandidateAttempt`: finalizes a rolled-back claim as a candidate result.
 * - `completeMemoryThreadCreationAttempt`: closes or removes the reservation on successful writes.
 * - `releaseMemoryThreadCreationAttempt`: removes an unfinished reservation after non-candidate failure.
 * - `lockMemoryThreadCandidateAttach`: serializes attach with create reservations before replay check.
 * - `beginMemoryThreadCandidateAttach` / `completeMemoryThreadCandidateAttach`: resolve attach branch.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import {
  THREAD_CREATION_ATTEMPT_LEASE_MILLISECONDS,
  THREAD_CREATION_MAX_ATTEMPTS,
} from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { MEMORY_THREAD_RETRY_EXHAUSTED_CODE } from "./memory-thread-candidate-refusal.js";
import { MemoryThreadCandidateError, type MemoryThreadCandidate } from "./memory-thread-write.js";

type AttemptStatus = "candidate" | "completed" | "pending" | "resolved";

interface AttemptSource {
  conversationId: string;
  inputHash: string;
  operationKey: string;
  partitionKey: string;
  scope: MemoryScope;
  timelineEntryId: string;
}

type SourceIdentity = Omit<AttemptSource, "inputHash" | "operationKey">;

interface AttemptRow {
  attempt_number: number;
  candidate_thread_refs: string[] | null;
  candidate_titles: string[] | null;
  conversation_id: string;
  input_hash: string;
  lease_active: boolean | null;
  lease_token: string | null;
  operation_key: string;
  scope: MemoryScope;
  scope_partition_key: string;
  status: AttemptStatus;
  timeline_entry_id: string;
}

export interface MemoryThreadCreationReservation {
  attemptNumber: number;
  leaseToken: string;
  operationKey: string;
}

function retryExhausted(): AppError {
  return new AppError(
    MEMORY_THREAD_RETRY_EXHAUSTED_CODE,
    "Отдельную нить не удалось создать после одной уточнённой попытки. Не повторяйте вызов для этого сообщения",
  );
}

function attemptInProgress(): AppError {
  return new AppError(
    "AGENT_MEMORY_THREAD_ATTEMPT_IN_PROGRESS",
    "Создание нити для этого сообщения уже выполняется. Дождитесь результата текущего вызова",
  );
}

function attemptStateInvalid(): AppError {
  return new AppError(
    "AGENT_MEMORY_THREAD_ATTEMPT_INVALID",
    "Сохранённое состояние попытки создания нити повреждено",
  );
}

function resolutionCompleted(): AppError {
  return new AppError(
    "AGENT_MEMORY_THREAD_RESOLUTION_COMPLETED",
    "Для этого сообщения уже завершена уточнённая попытка создания нити",
  );
}

function attemptStale(): AppError {
  return new AppError(
    "AGENT_MEMORY_THREAD_ATTEMPT_STALE",
    "Попытка создания нити уже завершена или заменена новым вызовом",
  );
}

function attemptSource(
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
): AttemptSource {
  if (input.thread?.action !== "create") {
    throw new AppError(
      "AGENT_MEMORY_THREAD_SOURCE_REQUIRED",
      "Для контроля создания нити требуется операция создания",
    );
  }
  return {
    ...sourceIdentity(auth, input),
    inputHash,
    operationKey: input.operationKey,
  };
}

function sourceIdentity(auth: MemoryAuthorization, input: CreateMemoryInput): SourceIdentity {
  const explicitSource = input.explicitSource;
  if (!explicitSource || !input.thread) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_SOURCE_REQUIRED",
      "Для контроля создания нити требуется проверенный источник текущего сообщения",
    );
  }
  const partitionKey = input.scope === "personal"
    ? auth.userId
    : input.scope === "group"
      ? auth.groupId
      : auth.familyId;
  if (!partitionKey) {
    throw new AppError(
      "AGENT_MEMORY_CONTEXT_INVALID",
      "Не удалось определить область попытки создания нити памяти",
    );
  }
  return {
    conversationId: explicitSource.conversationId,
    partitionKey,
    scope: input.scope,
    timelineEntryId: explicitSource.timelineEntryId,
  };
}

function requireSameRequest(row: AttemptRow, source: AttemptSource): void {
  if (row.conversation_id !== source.conversationId || row.scope !== source.scope ||
    row.scope_partition_key !== source.partitionKey || row.timeline_entry_id !== source.timelineEntryId) {
    throw new AppError(
      "AGENT_MEMORY_OPERATION_CONFLICT",
      "Идентификатор операции уже связан с другим источником памяти",
    );
  }
  if (row.input_hash !== source.inputHash) {
    throw new AppError(
      "AGENT_MEMORY_REPLAY_MISMATCH",
      "Повтор операции памяти не совпадает с исходным запросом",
    );
  }
}

function candidatesFromRow(row: AttemptRow): MemoryThreadCandidate[] {
  const references = row.candidate_thread_refs;
  const titles = row.candidate_titles;
  if (!references || !titles || references.length !== titles.length) {
    throw attemptStateInvalid();
  }
  return references.map((threadRef, index) => ({
    threadRef,
    title: titles[index]!,
  }));
}

function throwForExistingAttempt(row: AttemptRow, source: AttemptSource): void {
  requireSameRequest(row, source);
  if (row.status === "candidate" || row.status === "resolved") {
    throw new MemoryThreadCandidateError(candidatesFromRow(row));
  }
  if (row.status === "pending" && row.lease_active === true) {
    throw attemptInProgress();
  }
  if (row.status === "completed") throw attemptStateInvalid();
}

async function lockSource(client: PoolClient, source: SourceIdentity): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`memory-thread-attempt:${source.conversationId}:${source.timelineEntryId}`],
  );
}

async function operationAttempt(
  client: PoolClient,
  familyId: string,
  operationKey: string,
  forUpdate: boolean,
): Promise<AttemptRow | null> {
  const result = await client.query<AttemptRow>(
     `SELECT conversation_id, timeline_entry_id, scope::text, scope_partition_key,
            operation_key, input_hash, attempt_number, status, lease_token,
            lease_expires_at > now() AS lease_active, candidate_thread_refs, candidate_titles
     FROM memory_thread_creation_attempts
     WHERE family_id = $1 AND operation_key = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [familyId, operationKey],
  );
  return result.rows[0] ?? null;
}

export async function replayMemoryThreadCreationAttempt(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
): Promise<void> {
  const source = attemptSource(auth, input, inputHash);
  const replay = await operationAttempt(client, auth.familyId, source.operationKey, false);
  if (replay) throwForExistingAttempt(replay, source);
}

export async function reserveMemoryThreadCreationAttempt(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
): Promise<MemoryThreadCreationReservation> {
  const source = attemptSource(auth, input, inputHash);
  await lockSource(client, source);

  // Exact expired calls reclaim their own slot; a live call never runs E5 twice concurrently.
  const replay = await operationAttempt(client, auth.familyId, source.operationKey, true);
  const leaseToken = randomUUID();
  if (replay) {
    throwForExistingAttempt(replay, source);
    const reclaimed = await client.query<{ attempt_number: number }>(
      `UPDATE memory_thread_creation_attempts
       SET lease_token = $3, lease_expires_at = now() + ($4 * interval '1 millisecond'),
           updated_at = now()
       WHERE family_id = $1 AND operation_key = $2 AND status = 'pending'
       RETURNING attempt_number`,
      [auth.familyId, source.operationKey, leaseToken, THREAD_CREATION_ATTEMPT_LEASE_MILLISECONDS],
    );
    const attemptNumber = reclaimed.rows[0]?.attempt_number;
    if (!attemptNumber) throw attemptStateInvalid();
    return { attemptNumber, leaseToken, operationKey: source.operationKey };
  }

  // Expired abandoned operations have no result to replay and may yield their numbered slot.
  await client.query(
    `DELETE FROM memory_thread_creation_attempts
     WHERE family_id = $1 AND conversation_id = $2 AND timeline_entry_id = $3
       AND status = 'pending' AND lease_expires_at <= now()`,
    [auth.familyId, source.conversationId, source.timelineEntryId],
  );
  const attempts = await client.query<Pick<AttemptRow, "attempt_number" | "status">>(
    `SELECT attempt_number, status
     FROM memory_thread_creation_attempts
     WHERE family_id = $1 AND conversation_id = $2 AND timeline_entry_id = $3
     ORDER BY attempt_number
     FOR UPDATE`,
    [auth.familyId, source.conversationId, source.timelineEntryId],
  );
  if (attempts.rows.length >= THREAD_CREATION_MAX_ATTEMPTS) throw retryExhausted();
  if (attempts.rows.some((attempt) => attempt.status === "pending")) throw attemptInProgress();
  const attemptNumber = attempts.rows.length + 1;
  if (attemptNumber === 2 && attempts.rows[0]?.status !== "candidate") throw retryExhausted();

  await client.query(
    `INSERT INTO memory_thread_creation_attempts
       (family_id, scope, scope_partition_key, conversation_id, timeline_entry_id,
        operation_key, input_hash, attempt_number, status, lease_token, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9,
             now() + ($10 * interval '1 millisecond'))`,
    [auth.familyId, source.scope, source.partitionKey, source.conversationId,
      source.timelineEntryId, source.operationKey, source.inputHash, attemptNumber,
      leaseToken, THREAD_CREATION_ATTEMPT_LEASE_MILLISECONDS],
  );
  return { attemptNumber, leaseToken, operationKey: source.operationKey };
}

export async function requireMemoryThreadCreationReservation(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
  reservation: MemoryThreadCreationReservation,
): Promise<void> {
  const source = attemptSource(auth, input, inputHash);
  const row = await operationAttempt(client, auth.familyId, reservation.operationKey, true);
  if (!row) throw attemptStale();
  requireSameRequest(row, source);
  if (row.status !== "pending" || row.lease_token !== reservation.leaseToken ||
    row.attempt_number !== reservation.attemptNumber) {
    throw attemptStale();
  }
}

export async function recordMemoryThreadCandidateAttempt(
  client: PoolClient,
  auth: MemoryAuthorization,
  reservation: MemoryThreadCreationReservation,
  candidates: readonly MemoryThreadCandidate[],
): Promise<void> {
  if (candidates.length === 0) throw attemptStateInvalid();
  const result = await client.query(
    `UPDATE memory_thread_creation_attempts
     SET status = 'candidate', lease_token = NULL, lease_expires_at = NULL,
         candidate_thread_refs = $4, candidate_titles = $5, updated_at = now()
     WHERE family_id = $1 AND operation_key = $2 AND lease_token = $3 AND status = 'pending'`,
    [auth.familyId, reservation.operationKey, reservation.leaseToken,
      candidates.map((candidate) => candidate.threadRef),
      candidates.map((candidate) => candidate.title)],
  );
  if (result.rowCount !== 1) throw attemptStateInvalid();
}

export async function completeMemoryThreadCreationAttempt(
  client: PoolClient,
  auth: MemoryAuthorization,
  reservation: MemoryThreadCreationReservation,
): Promise<void> {
  const result = reservation.attemptNumber === 1
    ? await client.query(
        `DELETE FROM memory_thread_creation_attempts
         WHERE family_id = $1 AND operation_key = $2 AND lease_token = $3 AND status = 'pending'`,
        [auth.familyId, reservation.operationKey, reservation.leaseToken],
      )
    : await client.query(
        `UPDATE memory_thread_creation_attempts
         SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE family_id = $1 AND operation_key = $2 AND lease_token = $3 AND status = 'pending'`,
        [auth.familyId, reservation.operationKey, reservation.leaseToken],
      );
  if (result.rowCount !== 1) throw attemptStateInvalid();
}

export async function releaseMemoryThreadCreationAttempt(
  client: PoolClient,
  auth: MemoryAuthorization,
  reservation: MemoryThreadCreationReservation,
): Promise<void> {
  await client.query(
    `DELETE FROM memory_thread_creation_attempts
     WHERE family_id = $1 AND operation_key = $2 AND lease_token = $3 AND status = 'pending'`,
    [auth.familyId, reservation.operationKey, reservation.leaseToken],
  );
}

export async function beginMemoryThreadCandidateAttach(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
): Promise<boolean> {
  if (input.thread?.action !== "attach") return false;
  const source = sourceIdentity(auth, input);
  const attempts = await client.query<Pick<AttemptRow,
    "candidate_thread_refs" | "status">>(
    `SELECT status, candidate_thread_refs
     FROM memory_thread_creation_attempts
     WHERE family_id = $1 AND conversation_id = $2 AND timeline_entry_id = $3
     ORDER BY attempt_number
     FOR UPDATE`,
    [auth.familyId, source.conversationId, source.timelineEntryId],
  );
  if (attempts.rows.some((attempt) => attempt.status === "pending")) throw attemptInProgress();
  if (attempts.rows.some((attempt) => ["completed", "resolved"].includes(attempt.status))) {
    throw resolutionCompleted();
  }
  const candidates = attempts.rows.filter((attempt) => attempt.status === "candidate");
  if (candidates.length === 0) return false;
  const candidateRefs = candidates.flatMap((attempt) => attempt.candidate_thread_refs ?? []);
  if (!candidateRefs.includes(input.thread.threadRef)) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_ATTACH_CANDIDATE_MISMATCH",
      "Выбранная нить не входит в список найденных кандидатов. Используйте ссылку из результата remember",
    );
  }
  return true;
}

export async function lockMemoryThreadCandidateAttach(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
): Promise<boolean> {
  if (input.thread?.action !== "attach") return false;
  await lockSource(client, sourceIdentity(auth, input));
  return true;
}

export async function completeMemoryThreadCandidateAttach(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
): Promise<void> {
  const source = sourceIdentity(auth, input);
  const result = await client.query(
    `UPDATE memory_thread_creation_attempts
     SET status = 'resolved', updated_at = now()
     WHERE family_id = $1 AND conversation_id = $2 AND timeline_entry_id = $3
       AND status = 'candidate'`,
    [auth.familyId, source.conversationId, source.timelineEntryId],
  );
  if (!result.rowCount) throw attemptStateInvalid();
}
