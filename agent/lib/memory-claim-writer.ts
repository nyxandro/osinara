/**
 * Single transactional writer for source-backed and application-owned memory claims.
 *
 * Export:
 * - `createMemoryClaim`: replay-safe claim/reinforcement, evidence, optional thread, index, and audit write.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import { insertClaimEvidence } from "./claim-evidence-writer.js";
import { prepareExplicitClaimEvidence } from "./memory-explicit-claim-evidence.js";
import { database } from "./database.js";
import { fenceReviewMemoryWrite } from "./memory-review/memory-review-attempt.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { reinforceExactClaim } from "./memory-exact-reinforcement.js";
import { enforceMemoryQuota } from "./memory-quota.js";
import {
  memoryOperationHash,
  type CreateMemoryInput,
  type ReferencedMemoryItem,
  type ReferencedMemoryRow,
  rowToReferencedMemory,
  normalizeMemoryClaimContent,
} from "./memory-record.js";
import {
  beginMemoryThreadCandidateAttach,
  completeMemoryThreadCandidateAttach,
  completeMemoryThreadCreationAttempt,
  lockMemoryThreadCandidateAttach,
  recordMemoryThreadCandidateAttempt,
  releaseMemoryThreadCreationAttempt,
  replayMemoryThreadCreationAttempt,
  requireMemoryThreadCreationReservation,
  reserveMemoryThreadCreationAttempt,
  type MemoryThreadCreationReservation,
} from "./memory-thread-creation-attempts.js";
import {
  embedMemoryThreadTitle,
  isMemoryThreadCandidateError,
  materializeMemoryThreadWrite,
  prepareMemoryThreadWrite,
  type PreparedMemoryThreadWrite,
} from "./memory-thread-write.js";

interface CreateOperationRow {
  input_hash: string;
  memory_item_id: string | null;
  mutation_kind: "create" | "delete" | "update";
  thread_action: "attached" | "created" | null;
  thread_id: string | null;
  thread_ref: string | null;
}

function requireScope(auth: MemoryAuthorization, scope: MemoryScope): void {
  if (!auth.scopes.includes(scope)) {
    throw new AppError("AGENT_MEMORY_SCOPE_DENIED", "Эта информация недоступна в текущем чате");
  }
  if (scope === "personal" && !auth.userId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить владельца личной памяти");
  }
  if (scope === "group" && !auth.groupId) {
    throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить группу памяти");
  }
}

async function requireCurrentWriteContext(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
): Promise<void> {
  if (scope !== "group") {
    const member = await client.query(
      "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
      [auth.familyId, auth.userId],
    );
    if (member.rowCount) return;
    throw new AppError("AGENT_ACCESS_DENIED", "Доступ к семейному агенту был отозван");
  }
  const group = await client.query(
    "SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 FOR SHARE",
    [auth.groupId, auth.familyId],
  );
  if (!group.rowCount) {
    throw new AppError("AGENT_GROUP_NOT_REGISTERED", "Эта группа больше не подключена к агенту");
  }
}

async function existingCreate(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
): Promise<ReferencedMemoryItem | null> {
  const operation = await client.query<CreateOperationRow>(
    `SELECT operation.mutation_kind, operation.input_hash, operation.memory_item_id,
            operation.thread_id, operation.thread_action, thread.thread_ref
     FROM memory_mutation_operations AS operation
     LEFT JOIN memory_threads AS thread ON thread.id = operation.thread_id
     WHERE operation.family_id = $1 AND operation.operation_key = $2`,
    [auth.familyId, input.operationKey],
  );
  const replay = operation.rows[0];
  if (!replay) return null;
  if (replay.mutation_kind !== "create" || replay.input_hash !== inputHash) {
    throw new AppError(
      "AGENT_MEMORY_REPLAY_MISMATCH",
      "Повтор операции памяти не совпадает с исходным запросом",
    );
  }
  if (!replay.memory_item_id) {
    throw new AppError("AGENT_MEMORY_REPLAY_COMPLETED", "Исходная запись памяти уже удалена");
  }
  const result = await client.query<ReferencedMemoryRow>(
    `SELECT item.id, item.author_user_id, item.author_telegram_user_id, item.scope, item.kind,
            item.content, item.source, item.confirmation, item.sensitivity, item.message_thread_id,
            item.embedding_status, item.created_at, item.updated_at, ref.memory_ref
     FROM memory_items AS item
     JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
     WHERE item.id = $1 AND item.family_id = $2 AND (
       (item.scope = 'personal' AND 'personal' = ANY($3::memory_scope[])
         AND item.owner_user_id = $4) OR
       (item.scope = 'family' AND 'family' = ANY($3::memory_scope[])) OR
       (item.scope = 'group' AND 'group' = ANY($3::memory_scope[]) AND item.group_id = $5)
     )`,
    [replay.memory_item_id, auth.familyId, auth.scopes, auth.userId, auth.groupId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError("AGENT_MEMORY_REPLAY_COMPLETED", "Исходная запись памяти уже удалена");
  return {
    ...rowToReferencedMemory(row),
    ...(replay.thread_action && replay.thread_ref
      ? { thread: { action: replay.thread_action, threadRef: replay.thread_ref } }
      : {}),
  };
}

async function insertCreateOperation(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
  memoryItemId: string,
  thread: PreparedMemoryThreadWrite | null,
): Promise<void> {
  await client.query(
    `INSERT INTO memory_mutation_operations
       (family_id, operation_key, mutation_kind, input_hash, memory_item_id,
        actor_user_id, actor_telegram_user_id, eve_session_id, eve_turn_id,
        thread_id, thread_action)
     VALUES ($1, $2, 'create', $3, $4, $5, $6, $7, $8, $9, $10)`,
    [auth.familyId, input.operationKey, inputHash, memoryItemId,
      input.provenance && !input.systemActor ? auth.userId : null,
      input.provenance && !input.systemActor ? auth.telegramUserId : null,
       input.provenance?.sessionId ?? null,
       input.provenance?.turnId ?? null,
      thread?.threadId ?? null,
      thread?.result.action ?? null],
  );
}

async function replayBeforeTitleEmbedding(
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  inputHash: string,
): Promise<{
  replay: ReferencedMemoryItem | null;
  reservation: MemoryThreadCreationReservation | null;
}> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Replay must remain available when local E5 is down, but never bypass live authorization.
    await requireCurrentWriteContext(client, auth, input.scope);
    const replay = await existingCreate(client, auth, input, inputHash);
    if (replay) {
      await client.query("COMMIT");
      return { replay, reservation: null };
    }
    await fenceReviewMemoryWrite(client, input);
    await replayMemoryThreadCreationAttempt(client, auth, input, inputHash);
    // A new reservation is persisted only after the Telegram source has been verified in this scope.
    await prepareExplicitClaimEvidence(client, auth, input);
    const reservation = await reserveMemoryThreadCreationAttempt(client, auth, input, inputHash);
    await client.query("COMMIT");
    return { replay: null, reservation };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function releaseReservationAfterEmbeddingFailure(
  auth: MemoryAuthorization,
  reservation: MemoryThreadCreationReservation,
): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await releaseMemoryThreadCreationAttempt(client, auth, reservation);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function completeThreadReservation(
  client: PoolClient,
  auth: MemoryAuthorization,
  reservation: MemoryThreadCreationReservation | null,
): Promise<void> {
  if (reservation) await completeMemoryThreadCreationAttempt(client, auth, reservation);
}

async function completeThreadOutcome(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
  reservation: MemoryThreadCreationReservation | null,
  resolvingCandidate: boolean,
): Promise<void> {
  await completeThreadReservation(client, auth, reservation);
  if (resolvingCandidate) await completeMemoryThreadCandidateAttach(client, auth, input);
}

export async function createMemoryClaim(
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
): Promise<ReferencedMemoryItem> {
  if (input.systemActor &&
    (!input.provenance?.sessionId || !input.provenance.turnId)) {
    throw new AppError(
      "AGENT_MEMORY_SYSTEM_PROVENANCE_REQUIRED",
      "Системная запись памяти требует проверенный контекст выполнения Eve",
    );
  }
  requireScope(auth, input.scope);
  // Attempt fencing is verified context, not mutation content; keep shipped replay hashes stable.
  const { memoryReviewBatchId: _reviewBatchId, ...operationInput } = input;
  const inputHash = memoryOperationHash(operationInput);
  let reservation: MemoryThreadCreationReservation | null = null;
  if (input.thread?.action === "create") {
    const preflight = await replayBeforeTitleEmbedding(auth, input, inputHash);
    const { replay } = preflight;
    if (replay) return replay;
    reservation = preflight.reservation;
  }
  let titleEmbedding: Awaited<ReturnType<typeof embedMemoryThreadTitle>>;
  try {
    titleEmbedding = await embedMemoryThreadTitle(input.thread);
  } catch (error) {
    // An explicit failed call may retry; a crash instead leaves a bounded lease for safe takeover.
    if (reservation) await releaseReservationAfterEmbeddingFailure(auth, reservation);
    throw error;
  }
  const client = await database().connect();
  let savepointCreated = false;
  let resolvingCandidate = false;
  try {
    await client.query("BEGIN");
    await requireCurrentWriteContext(client, auth, input.scope);
    const replay = await existingCreate(client, auth, input, inputHash);
    if (replay) {
      if (reservation) await releaseMemoryThreadCreationAttempt(client, auth, reservation);
      await client.query("COMMIT");
      return replay;
    }
    await fenceReviewMemoryWrite(client, input);
    const attachLocked = await lockMemoryThreadCandidateAttach(client, auth, input);
    if (attachLocked) {
      // The operation can commit while this concurrent replay waits for the source lock.
      const lockedReplay = await existingCreate(client, auth, input, inputHash);
      if (lockedReplay) {
        await client.query("COMMIT");
        return lockedReplay;
      }
      resolvingCandidate = await beginMemoryThreadCandidateAttach(client, auth, input);
    }
    if (reservation) {
      await requireMemoryThreadCreationReservation(client, auth, input, inputHash, reservation);
      // The reservation row and live membership locks predate this savepoint and survive claim rollback.
      await client.query("SAVEPOINT memory_thread_claim_write");
      savepointCreated = true;
    }
    let prepared = input.explicitSource
      ? await prepareExplicitClaimEvidence(client, auth, input)
      : null;
    if (input.thread && !prepared) {
      throw new AppError(
        "AGENT_MEMORY_THREAD_SOURCE_REQUIRED",
        "Нить памяти можно изменить только вместе с проверенным источником сообщения",
      );
    }
    const threadWrite = prepared
      ? await prepareMemoryThreadWrite(
          client,
          auth,
          input.scope,
          input.thread,
          prepared,
          titleEmbedding,
        )
      : null;
    if (threadWrite) prepared = threadWrite.preparedEvidence;
    const ownerUserId = input.scope === "personal" ? auth.userId : null;
    const groupId = input.scope === "group" ? auth.groupId : null;
    const authorUserId = prepared?.primaryAuthorUserId ?? auth.userId;
    if (input.scope !== "group" && !authorUserId) {
      throw new AppError("AGENT_MEMORY_CONTEXT_INVALID", "Не удалось определить автора памяти");
    }
    const scopePartitionKey = input.scope === "personal"
      ? auth.userId!
      : input.scope === "group"
        ? auth.groupId!
        : auth.familyId;
    const contentNormalized = prepared?.contentNormalized ?? normalizeMemoryClaimContent(input.content);
    const reinforced = await reinforceExactClaim(client, auth, {
      contentNormalized,
      memoryProjectId: threadWrite?.identity.memoryProjectId ?? null,
      operationKey: input.operationKey,
      prepared,
      scope: input.scope,
      scopePartitionKey,
      subjectLabel: prepared?.subjectLabel ?? null,
      subjectParticipantId: prepared?.subjectParticipantId ?? null,
      subjectUserId: prepared?.subjectUserId ?? null,
      systemActor: input.systemActor === true,
    });
    if (reinforced) {
      if (threadWrite) {
        await materializeMemoryThreadWrite(
          client,
          auth,
          reinforced.id,
          threadWrite,
          input.systemActor === true,
        );
      }
      await insertCreateOperation(client, auth, input, inputHash, reinforced.id, threadWrite);
      await completeThreadOutcome(client, auth, input, reservation, resolvingCandidate);
      await client.query("COMMIT");
      return {
        ...rowToReferencedMemory(reinforced),
        ...(threadWrite ? { thread: threadWrite.result } : {}),
      };
    }

    await enforceMemoryQuota(client, auth, input.scope);
    const endorsedByUserId = prepared?.primaryAuthorUserId ?? null;
    const result = await client.query<Omit<ReferencedMemoryRow, "memory_ref">>(
      `INSERT INTO memory_items
         (family_id, owner_user_id, group_id, author_user_id, author_telegram_user_id,
          scope, kind, content, source, source_event_id, message_thread_id, confirmation,
          sensitivity, operation_key, origin_conversation_id, subject_participant_id,
           subject_conversation_id, subject_user_id, subject_label, memory_project_id, save_approved,
           endorsed_by_user_id, endorsed_at, provenance_state, content_normalized, profile_eligible,
           claim_status, duplicate_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                $15, $16, $17, $18, $19, $20, $21, $22,
                CASE WHEN $22::uuid IS NULL THEN NULL ELSE now() END, $23, $24, $25, $26, $27)
       RETURNING id, author_user_id, author_telegram_user_id, scope, kind, content, source,
                 confirmation, sensitivity, message_thread_id, embedding_status, created_at, updated_at`,
      [auth.familyId, ownerUserId, groupId, authorUserId,
        prepared?.primaryAuthorTelegramUserId ?? (input.scope === "group" ? auth.telegramUserId : null),
        input.scope, input.kind, input.content, input.source, input.sourceEventId ?? null,
        input.messageThreadId ?? null, input.confirmation, input.sensitivity, input.operationKey,
        prepared?.conversationId ?? null, prepared?.subjectParticipantId ?? null,
        prepared?.subjectConversationId ?? null, prepared?.subjectUserId ?? null,
         prepared?.subjectLabel ?? null, threadWrite?.identity.memoryProjectId ?? null,
         prepared === null ? null : input.confirmation === "user_confirmed",
         endorsedByUserId, prepared === null ? "legacy_unresolved" : "evidenced",
          contentNormalized,
          prepared !== null && input.sensitivity === "normal" &&
            (prepared.subjectUserId !== null || prepared.subjectParticipantId !== null),
          "active",
          null],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("AGENT_MEMORY_WRITE_FAILED", "Не удалось сохранить запись памяти");
    if (prepared !== null) await insertClaimEvidence(client, row.id, prepared);
    if (threadWrite) {
      await materializeMemoryThreadWrite(client, auth, row.id, threadWrite, input.systemActor === true);
    }

    const reference = await client.query<{ memory_ref: string }>(
      "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
      [row.id],
    );
    const memoryRef = reference.rows[0]?.memory_ref;
    if (!memoryRef) {
      throw new AppError(
        "AGENT_MEMORY_REF_CREATE_FAILED",
        "Не удалось создать безопасную ссылку на запись памяти",
      );
    }
    await insertCreateOperation(client, auth, input, inputHash, row.id, threadWrite);
    await client.query("INSERT INTO memory_embedding_jobs (memory_item_id) VALUES ($1)", [row.id]);
    await client.query(
      `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
       VALUES ($1, $2, 'memory.created', $3,
               jsonb_build_object('scope', $4::text, 'kind', $5::text, 'sensitivity', $6::text))`,
       [auth.familyId, input.systemActor ? null : prepared?.auditActorUserId ?? auth.userId, row.id,
        input.scope, input.kind, input.sensitivity],
    );
    await completeThreadOutcome(client, auth, input, reservation, resolvingCandidate);
    await client.query("COMMIT");
    return {
      ...rowToReferencedMemory({ ...row, memory_ref: memoryRef }),
      ...(threadWrite ? { thread: threadWrite.result } : {}),
    };
  } catch (error) {
    if (reservation && savepointCreated) {
      try {
        // Claim/project writes roll back while the pre-savepoint auth and reservation locks remain held.
        await client.query("ROLLBACK TO SAVEPOINT memory_thread_claim_write");
        if (isMemoryThreadCandidateError(error)) {
          await recordMemoryThreadCandidateAttempt(client, auth, reservation, error.candidates);
        } else {
          await releaseMemoryThreadCreationAttempt(client, auth, reservation);
        }
        await client.query("COMMIT");
      } catch (finalizationError) {
        await client.query("ROLLBACK");
        throw finalizationError;
      }
    } else {
      await client.query("ROLLBACK");
      if (reservation) {
        try {
          await client.query("BEGIN");
          await releaseMemoryThreadCreationAttempt(client, auth, reservation);
          await client.query("COMMIT");
        } catch (releaseError) {
          await client.query("ROLLBACK");
          throw releaseError;
        }
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
