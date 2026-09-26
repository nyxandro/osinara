/**
 * Atomic main-agent memory-thread write boundary.
 *
 * Exports:
 * - `requireMemoryThreadTitle`: validates a requested title before the write embeds anything.
 * - `prepareMemoryThreadWrite`: resolves an authorized thread/project/subject identity in transaction.
 * - `materializeMemoryThreadWrite`: links the committed claim and records an opaque result and audit.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { PreparedClaimEvidence } from "./claim-evidence-writer.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  THREAD_CREATION_CANDIDATE_LIMIT,
  THREAD_CREATION_TITLE_MIN_SEMANTIC_SIMILARITY,
  THREAD_PURPOSE_MIN_TRIGRAM_SIMILARITY,
  THREAD_PURPOSE_MAX_CHARACTERS,
  THREAD_TITLE_MAX_CHARACTERS,
} from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type {
  CreateMemoryThreadInput,
  MemoryThreadWriteResult,
} from "./memory-record.js";

interface ThreadIdentity {
  memoryProjectId: string | null;
  subjectConversationId: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
}

interface ThreadRow extends ThreadIdentity {
  id: string;
  parentThreadId: string | null;
  threadRef: string;
}

interface SimilarThreadRow {
  thread_ref: string;
  title: string;
}

export interface MemoryThreadCandidate {
  threadRef: string;
  title: string;
}

export class MemoryThreadCandidateError extends AppError {
  readonly candidates: readonly MemoryThreadCandidate[];

  constructor(candidates: readonly MemoryThreadCandidate[]) {
    const references = candidates
      .map((candidate) => `«${candidate.title}» (${candidate.threadRef})`)
      .join(", ");
    super(
      "AGENT_MEMORY_THREAD_CANDIDATE_EXISTS",
      `Похожая нить уже существует: ${references}. При совпадении прикрепите запись; ` +
        "иначе сделайте не более одной попытки с уточнёнными названием и назначением новой нити",
    );
    this.candidates = candidates;
  }
}

export function isMemoryThreadCandidateError(error: unknown): error is MemoryThreadCandidateError {
  return error instanceof MemoryThreadCandidateError;
}

export interface PreparedMemoryThreadWrite {
  identity: ThreadIdentity;
  preparedEvidence: PreparedClaimEvidence;
  result: MemoryThreadWriteResult;
  role: CreateMemoryThreadInput["role"];
  threadId: string;
}

function invalidInput(message: string): AppError {
  return new AppError("AGENT_MEMORY_THREAD_INPUT_INVALID", message);
}

function scopePartitionKey(auth: MemoryAuthorization, scope: MemoryScope): string {
  if (scope === "personal" && auth.userId) return auth.userId;
  if (scope === "group" && auth.groupId) return auth.groupId;
  if (scope === "family") return auth.familyId;
  throw new AppError(
    "AGENT_MEMORY_CONTEXT_INVALID",
    "Не удалось определить область для записи нити памяти",
  );
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS ||
    !vector.every((value) => Number.isFinite(value))) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_TITLE_EMBEDDING_INVALID",
      "Не удалось построить смысловой индекс названия нити памяти",
    );
  }
  return `[${vector.join(",")}]`;
}

/**
 * The title a thread creation needs embedded, checked but not yet sent. Embedding happens once
 * for the whole write, together with the neighbour probe, so one claim costs one request.
 */
export function requireMemoryThreadTitle(
  input: CreateMemoryThreadInput | undefined,
): string | null {
  if (!input || input.action !== "create") return null;
  if (!input.title.trim() || input.title.length > THREAD_TITLE_MAX_CHARACTERS ||
    !input.purpose.trim() || input.purpose.length > THREAD_PURPOSE_MAX_CHARACTERS) {
    throw invalidInput("Название или назначение нити памяти не соответствует допустимым границам");
  }
  return input.title;
}

async function loadThread(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
  threadRef: string,
  rootOnly: boolean,
): Promise<ThreadRow> {
  const result = await client.query<{
    id: string;
    memory_project_id: string | null;
    parent_thread_id: string | null;
    subject_conversation_id: string | null;
    subject_participant_id: string | null;
    subject_user_id: string | null;
    thread_ref: string;
  }>(
    `SELECT id, thread_ref, parent_thread_id, subject_user_id, subject_participant_id,
            subject_conversation_id, memory_project_id
     FROM memory_threads
     WHERE thread_ref = $1 AND family_id = $2 AND scope = $3 AND scope_partition_key = $4
       AND status = 'active' AND ($5::boolean = false OR parent_thread_id IS NULL)
     FOR UPDATE`,
    [threadRef, auth.familyId, scope, scopePartitionKey(auth, scope), rootOnly],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError("AGENT_MEMORY_THREAD_NOT_FOUND", "Нить памяти не найдена в текущей области");
  }
  return {
    id: row.id,
    memoryProjectId: row.memory_project_id,
    parentThreadId: row.parent_thread_id,
    subjectConversationId: row.subject_conversation_id,
    subjectParticipantId: row.subject_participant_id,
    subjectUserId: row.subject_user_id,
    threadRef: row.thread_ref,
  };
}

function sourceSubject(
  scope: MemoryScope,
  prepared: PreparedClaimEvidence,
): ThreadIdentity {
  if (prepared.subjectKind === "label" || prepared.subjectKind === "none") {
    throw invalidInput("Subject-thread требует явного current_author или verified_ref");
  }
  if (prepared.subjectUserId || prepared.subjectParticipantId) {
    return {
      memoryProjectId: null,
      subjectConversationId: prepared.subjectConversationId,
      subjectParticipantId: prepared.subjectParticipantId,
      subjectUserId: prepared.subjectUserId,
    };
  }
  throw invalidInput(`Не удалось вывести ${scope} subject identity из проверенного источника`);
}

function withThreadIdentity(
  prepared: PreparedClaimEvidence,
  identity: ThreadIdentity,
): PreparedClaimEvidence {
  const primary = prepared.sources.find((source) => source.role === "primary");
  const reported = primary !== undefined && (
    (identity.subjectParticipantId !== null &&
      identity.subjectParticipantId !== primary.authorParticipantId) ||
    (identity.subjectUserId !== null && identity.subjectUserId !== primary.authorUserId)
  );
  return {
    ...prepared,
    evidenceKind: reported ? "reported" : prepared.evidenceKind,
    subjectConversationId: identity.subjectConversationId,
    subjectParticipantId: identity.subjectParticipantId,
    subjectUserId: identity.subjectUserId,
  };
}

function requireCompatibleIdentity(
  prepared: PreparedClaimEvidence,
  identity: ThreadIdentity,
): void {
  if (identity.memoryProjectId !== null) {
    if (prepared.subjectKind !== "none") {
      throw invalidInput("Project-thread принимает только явный subject.kind=none");
    }
    return;
  }
  if (prepared.subjectKind !== "current_author" && prepared.subjectKind !== "verified_ref") {
    throw invalidInput(
      "Subject-thread требует явный current_author или verified_ref; identity нити не наследуется",
    );
  }
  const subjectMismatch =
    (prepared.subjectUserId !== null && prepared.subjectUserId !== identity.subjectUserId) ||
    (prepared.subjectParticipantId !== null &&
      prepared.subjectParticipantId !== identity.subjectParticipantId) ||
    ((prepared.subjectUserId !== null || prepared.subjectParticipantId !== null) &&
      identity.memoryProjectId !== null);
  if (subjectMismatch) {
    throw invalidInput("Субъект записи не совпадает с проверенной identity выбранной нити");
  }
}

async function projectIdentity(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
  title: string,
  prepared: PreparedClaimEvidence,
): Promise<ThreadIdentity> {
  if (scope === "personal" || prepared.subjectKind !== "none") {
    throw invalidInput("Project identity доступна только для общей семейной или групповой записи");
  }
  const partition = scopePartitionKey(auth, scope);
  const project = await client.query<{ id: string }>(
    `INSERT INTO memory_projects (family_id, group_id, scope, scope_partition_key, title)
     VALUES ($1, CASE WHEN $2::memory_scope = 'group' THEN $3::uuid ELSE NULL END, $2, $3, $4)
     ON CONFLICT (family_id, scope, scope_partition_key, title_normalized)
     DO UPDATE SET updated_at = memory_projects.updated_at
     RETURNING id`,
    [auth.familyId, scope, partition, title],
  );
  return {
    memoryProjectId: project.rows[0]!.id,
    subjectConversationId: null,
    subjectParticipantId: null,
    subjectUserId: null,
  };
}

async function findOrCreateThread(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
  input: Extract<CreateMemoryThreadInput, { action: "create" }>,
  identity: ThreadIdentity,
  parentThreadId: string | null,
  titleEmbedding: readonly number[],
): Promise<{ action: "attached" | "created"; id: string; threadRef: string }> {
  const partition = scopePartitionKey(auth, scope);
  const existing = await client.query<{
    id: string;
    status: "active" | "completed";
    thread_ref: string;
  }>(
    `SELECT id, thread_ref, status::text FROM memory_threads
     WHERE family_id = $1 AND scope = $2 AND scope_partition_key = $3
       AND subject_user_id IS NOT DISTINCT FROM $4::uuid
       AND subject_participant_id IS NOT DISTINCT FROM $5::uuid
       AND memory_project_id IS NOT DISTINCT FROM $6::uuid
       AND parent_thread_id IS NOT DISTINCT FROM $7::uuid
       AND title_normalized = lower(regexp_replace(trim($8), '\\s+', ' ', 'g'))
     FOR UPDATE`,
    [auth.familyId, scope, partition, identity.subjectUserId, identity.subjectParticipantId,
      identity.memoryProjectId, parentThreadId, input.title],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].status === "completed") {
      throw new AppError(
        "AGENT_MEMORY_THREAD_TITLE_CONFLICT",
        "Нить с таким названием уже завершена. Выберите другое название или явно реактивируйте её",
      );
    }
    return { action: "attached", id: existing.rows[0].id, threadRef: existing.rows[0].thread_ref };
  }

  // A project root has no identity until this transaction creates its project row. Compare it with
  // all subjectless project roots in the same partition; subject and child threads stay exact-axis.
  const projectRoot = identity.memoryProjectId !== null && parentThreadId === null;
  const candidates = await client.query<SimilarThreadRow>(
    `SELECT thread.thread_ref, thread.title,
            similarity(
              lower(regexp_replace(trim(thread.purpose), '\\s+', ' ', 'g')),
              lower(regexp_replace(trim($9::text), '\\s+', ' ', 'g'))
            ) AS purpose_similarity,
            CASE WHEN thread.title_embedding_model = $11::text
              THEN 1 - (thread.title_embedding <=> $10::vector) ELSE NULL
            END AS semantic_similarity
     FROM memory_threads AS thread
     WHERE thread.family_id = $1 AND thread.scope = $2 AND thread.scope_partition_key = $3
       AND thread.status = 'active'
       AND thread.title_normalized <>
         lower(regexp_replace(trim($8::text), '\\s+', ' ', 'g'))
       AND thread.parent_thread_id IS NOT DISTINCT FROM $7::uuid
       AND (
         ($14::boolean AND thread.subject_user_id IS NULL
           AND thread.subject_participant_id IS NULL AND thread.memory_project_id IS NOT NULL) OR
         (NOT $14::boolean
           AND thread.subject_user_id IS NOT DISTINCT FROM $4::uuid
           AND thread.subject_participant_id IS NOT DISTINCT FROM $5::uuid
           AND thread.memory_project_id IS NOT DISTINCT FROM $6::uuid)
       )
       AND (
         (thread.title_embedding_model = $11::text
           AND 1 - (thread.title_embedding <=> $10::vector) >= $12::double precision) OR
         similarity(
           lower(regexp_replace(trim(thread.purpose), '\\s+', ' ', 'g')),
           lower(regexp_replace(trim($9::text), '\\s+', ' ', 'g'))
         ) >= $13::double precision
       )
     ORDER BY semantic_similarity DESC NULLS LAST, purpose_similarity DESC,
              thread.updated_at DESC, thread.id
     LIMIT $15`,
    [auth.familyId, scope, partition, identity.subjectUserId, identity.subjectParticipantId,
      identity.memoryProjectId, parentThreadId, input.title, input.purpose,
      vectorLiteral(titleEmbedding), MEMORY_EMBEDDING_MODEL_VERSION,
      THREAD_CREATION_TITLE_MIN_SEMANTIC_SIMILARITY,
      THREAD_PURPOSE_MIN_TRIGRAM_SIMILARITY,
      projectRoot, THREAD_CREATION_CANDIDATE_LIMIT],
  );
  if (candidates.rows.length > 0) {
    throw new MemoryThreadCandidateError(candidates.rows.map((candidate) => ({
      threadRef: candidate.thread_ref,
      title: candidate.title,
    })));
  }

  const inserted = await client.query<{ id: string; thread_ref: string }>(
    `INSERT INTO memory_threads
       (family_id, scope, scope_partition_key, subject_user_id, subject_participant_id,
        subject_conversation_id, memory_project_id, parent_thread_id, title, purpose,
        title_embedding, title_embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12)
     RETURNING id, thread_ref`,
    [auth.familyId, scope, partition, identity.subjectUserId, identity.subjectParticipantId,
      identity.subjectConversationId, identity.memoryProjectId, parentThreadId, input.title,
      input.purpose, vectorLiteral(titleEmbedding), MEMORY_EMBEDDING_MODEL_VERSION],
  );
  return { action: "created", id: inserted.rows[0]!.id, threadRef: inserted.rows[0]!.thread_ref };
}

export async function prepareMemoryThreadWrite(
  client: PoolClient,
  auth: MemoryAuthorization,
  scope: MemoryScope,
  input: CreateMemoryThreadInput | undefined,
  prepared: PreparedClaimEvidence,
  titleEmbedding: readonly number[] | null,
): Promise<PreparedMemoryThreadWrite | null> {
  if (!input) return null;
  const partition = scopePartitionKey(auth, scope);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`memory-thread-write:${auth.familyId}:${scope}:${partition}`],
  );
  if (input.action === "attach") {
    const thread = await loadThread(client, auth, scope, input.threadRef, false);
    requireCompatibleIdentity(prepared, thread);
    return {
      identity: thread,
      preparedEvidence: withThreadIdentity(prepared, thread),
      result: { action: "attached", threadRef: thread.threadRef },
      role: input.role,
      threadId: thread.id,
    };
  }
  if (!titleEmbedding) throw invalidInput("Для новой нити отсутствует проверенный смысловой индекс");
  const parent = input.parentThreadRef
    ? await loadThread(client, auth, scope, input.parentThreadRef, true)
    : null;
  if (parent) requireCompatibleIdentity(prepared, parent);
  const identity = parent ?? (input.identity === "project"
    ? await projectIdentity(client, auth, scope, input.title, prepared)
    : sourceSubject(scope, prepared));
  const thread = await findOrCreateThread(
    client,
    auth,
    scope,
    input,
    identity,
    parent?.id ?? null,
    titleEmbedding,
  );
  return {
    identity,
    preparedEvidence: withThreadIdentity(prepared, identity),
    result: { action: thread.action, threadRef: thread.threadRef },
    role: input.role,
    threadId: thread.id,
  };
}

export async function materializeMemoryThreadWrite(
  client: PoolClient,
  auth: MemoryAuthorization,
  claimId: string,
  prepared: PreparedMemoryThreadWrite,
  systemActor: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO memory_thread_entries
       (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
     SELECT $1, item.family_id, item.scope, item.scope_partition_key, item.id, $2,
            COALESCE(evidence.observed_at, item.created_at)
     FROM memory_items AS item
     LEFT JOIN LATERAL (
       SELECT observed_at FROM claim_evidence
       WHERE claim_id = item.id AND evidence_role = 'primary' LIMIT 1
     ) AS evidence ON true
     WHERE item.id = $3
     ON CONFLICT (thread_id, source_claim_id, source_outcome_id) DO NOTHING`,
    [prepared.threadId, prepared.role, claimId],
  );
  // Group-origin threads are fully materialized but remain silent in every shared chat.
  if (prepared.result.action === "created" && prepared.preparedEvidence.telegramGroupId === null) {
    await client.query(
      `INSERT INTO memory_thread_creation_notices
         (thread_id, family_id, origin_conversation_id) VALUES ($1, $2, $3)`,
      [prepared.threadId, auth.familyId, prepared.preparedEvidence.conversationId],
    );
  }
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4,
             jsonb_build_object('threadRef', $5::text, 'role', $6::text))`,
    [auth.familyId, systemActor ? null : auth.userId,
      prepared.result.action === "created" ? "memory.thread_created" : "memory.thread_attached",
      claimId, prepared.result.threadRef, prepared.role],
  );
}
