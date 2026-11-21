/**
 * Authorized opaque memory-thread list, search, and bounded history reads.
 *
 * Exports:
 * - Model-safe thread summary/history contracts.
 * - `memoryThreadQueryRepository`: scoped pagination and semantic title search without raw IDs.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { embedMemoryQuery } from "./memory-embedding-client.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  THREAD_HISTORY_PAGE_MAX_CHARACTERS,
  THREAD_HISTORY_PAGE_MAX_ENTRIES,
  THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
} from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import { formatMemorySubjectPerson } from "./memory-subject-person.js";
import type { ModelMemoryEvidence } from "./model-memory.js";

export const THREAD_REF_PATTERN = /^thread_[0-9a-f]{32}$/u;
export const THREAD_ENTRY_REF_PATTERN = /^entry_[0-9a-f]{32}$/u;

export interface ModelMemoryThreadSummary {
  parentThreadRef: string | null;
  purpose: string;
  status: "active" | "completed";
  threadRef: string;
  title: string;
  updatedAt: string;
}

export interface ModelMemoryThreadEntry {
  /** The person the entry's record is bound to, as in `ModelMemory.about`; absent for an outcome. */
  about?: string;
  content: string;
  entryRef: string;
  occurredAt: string;
  role: "constraint" | "decision" | "episode" | "goal" | "lesson" | "method" | "open_loop" | "outcome";
  sourceRef: string;
  sourceEvidence: ModelMemoryEvidence;
  sourceType: "claim" | "confirmed_outcome";
}

interface ThreadSummaryRow {
  parent_thread_ref: string | null;
  purpose: string;
  status: "active" | "completed";
  thread_ref: string;
  title: string;
  updated_at: Date;
}

type ThreadReadRow = ThreadSummaryRow & { id: string } & ({
  content: null;
  entry_ref: null;
  occurred_at: null;
  role: null;
  source_author_label: null;
  source_evidence_kind: null;
  source_observed_at: null;
  source_ref: null;
  source_type: null;
  subject_person_name: null;
  subject_person_username: null;
} | {
  content: string;
  entry_ref: string;
  occurred_at: Date;
  role: ModelMemoryThreadEntry["role"];
  source_author_label: string;
  source_evidence_kind: ModelMemoryEvidence["kind"];
  source_observed_at: Date;
  source_ref: string;
  source_type: ModelMemoryThreadEntry["sourceType"];
  subject_person_name: string | null;
  subject_person_username: string | null;
});

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS ||
    !vector.every((value) => Number.isFinite(value))) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_QUERY_EMBEDDING_INVALID",
      "Не удалось выполнить смысловой поиск нитей памяти",
    );
  }
  return `[${vector.join(",")}]`;
}

function toSummary(row: ThreadSummaryRow): ModelMemoryThreadSummary {
  return {
    parentThreadRef: row.parent_thread_ref,
    purpose: row.purpose,
    status: row.status,
    threadRef: row.thread_ref,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
  };
}

function requireLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > THREAD_HISTORY_PAGE_MAX_ENTRIES) {
    throw new AppError("AGENT_MEMORY_THREAD_LIMIT_INVALID", "Некорректный лимит нитей памяти");
  }
  return limit;
}

export const memoryThreadQueryRepository = {
  async list(
    auth: MemoryAuthorization,
    input: { cursor?: string; limit: number; scope?: MemoryScope; status?: "active" | "completed" },
  ): Promise<{ items: ModelMemoryThreadSummary[]; nextCursor: string | null }> {
    const limit = requireLimit(input.limit);
    if (input.scope && !auth.scopes.includes(input.scope)) {
      throw new AppError("AGENT_MEMORY_SCOPE_DENIED", "Эта область нитей памяти недоступна в текущем чате");
    }
    if (input.cursor && !THREAD_REF_PATTERN.test(input.cursor)) {
      throw new AppError("AGENT_MEMORY_THREAD_CURSOR_INVALID", "Некорректный курсор списка нитей памяти");
    }
    const result = await database().query<ThreadSummaryRow>(
      `SELECT thread.thread_ref, thread.title, thread.purpose, thread.status::text,
              thread.updated_at, parent.thread_ref AS parent_thread_ref
       FROM memory_threads AS thread
       LEFT JOIN memory_threads AS parent ON parent.id = thread.parent_thread_id
        LEFT JOIN memory_threads AS cursor ON cursor.thread_ref = $5
        WHERE thread.family_id = $1 AND ${liveMemoryReadPredicate({
          alias: "thread",
          personalIdentityColumn: "scope_partition_key",
        })}
         AND ($6::memory_scope IS NULL OR thread.scope = $6)
         AND ($7::memory_thread_status IS NULL OR thread.status = $7)
         AND ($5::text IS NULL OR (thread.updated_at, thread.thread_ref) <
           (cursor.updated_at, cursor.thread_ref))
       ORDER BY thread.updated_at DESC, thread.thread_ref DESC LIMIT $8`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId, input.cursor ?? null,
        input.scope ?? null, input.status ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(toSummary),
      nextCursor: result.rows.length > limit ? rows.at(-1)!.thread_ref : null,
    };
  },

  async search(
    auth: MemoryAuthorization,
    query: string,
    limit: number,
  ): Promise<ModelMemoryThreadSummary[]> {
    const normalized = query.normalize("NFKC").trim();
    if (!normalized) {
      throw new AppError("AGENT_MEMORY_THREAD_QUERY_INVALID", "Для поиска нитей памяти нужен запрос");
    }
    requireLimit(limit);
    const embedding = await embedMemoryQuery(normalized);
    const result = await database().query<ThreadSummaryRow>(
      `SELECT thread.thread_ref, thread.title, thread.purpose, thread.status::text,
              thread.updated_at, parent.thread_ref AS parent_thread_ref
       FROM memory_threads AS thread
        LEFT JOIN memory_threads AS parent ON parent.id = thread.parent_thread_id
        WHERE thread.family_id = $1 AND ${liveMemoryReadPredicate({
          alias: "thread",
          personalIdentityColumn: "scope_partition_key",
        })}
         AND (thread.title_normalized % lower($5) OR lower(thread.purpose) % lower($5)
           OR (thread.title_embedding_model = $7
             AND 1 - (thread.title_embedding <=> $6::vector) >= $8))
       ORDER BY CASE WHEN thread.title_embedding_model = $7
                  THEN 1 - (thread.title_embedding <=> $6::vector) ELSE 0 END DESC,
                similarity(thread.title_normalized, lower($5)) DESC,
                thread.updated_at DESC LIMIT $9`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId, normalized,
        vectorLiteral(embedding), MEMORY_EMBEDDING_MODEL_VERSION,
        THREAD_TITLE_MIN_SEMANTIC_SIMILARITY, limit],
    );
    return result.rows.map(toSummary);
  },

  async read(
    auth: MemoryAuthorization,
    threadRef: string,
    input: { cursor?: string; limit: number },
  ): Promise<{
    entries: ModelMemoryThreadEntry[];
    nextCursor: string | null;
    thread: ModelMemoryThreadSummary;
    totalCharacters: number;
  }> {
    if (!THREAD_REF_PATTERN.test(threadRef) ||
      (input.cursor !== undefined && !THREAD_ENTRY_REF_PATTERN.test(input.cursor))) {
      throw new AppError("AGENT_MEMORY_THREAD_REF_INVALID", "Некорректная ссылка на нить памяти");
    }
    const limit = requireLimit(input.limit);
    // Summary and history share one authorization snapshot, avoiding a preflight/read TOCTOU.
    const result = await database().query<ThreadReadRow>(
      `WITH authorized_thread AS (
         SELECT thread.id, thread.thread_ref, thread.title, thread.purpose, thread.status::text,
                thread.updated_at, parent.thread_ref AS parent_thread_ref
         FROM memory_threads AS thread
         LEFT JOIN memory_threads AS parent ON parent.id = thread.parent_thread_id
         WHERE thread.thread_ref = $5 AND thread.family_id = $1
           AND ${liveMemoryReadPredicate({
             alias: "thread",
             personalIdentityColumn: "scope_partition_key",
           })}
       )
       SELECT thread.*, history.*
       FROM authorized_thread AS thread
       LEFT JOIN LATERAL (
         SELECT entry.entry_ref, entry.role::text, entry.occurred_at,
                COALESCE(claim.content, outcome.summary) AS content,
                COALESCE(memory_ref.memory_ref, outcome.outcome_ref) AS source_ref,
                CASE WHEN claim.id IS NULL THEN 'confirmed_outcome' ELSE 'claim' END AS source_type,
                COALESCE(source_evidence.evidence_kind, 'unresolved') AS source_evidence_kind,
                COALESCE(source_evidence.author_label_snapshot, 'Источник не установлен')
                  AS source_author_label,
                COALESCE(source_evidence.observed_at, entry.occurred_at) AS source_observed_at,
                subject_person.name AS subject_person_name,
                subject_person.username AS subject_person_username
         FROM memory_thread_entries AS entry
         LEFT JOIN memory_items AS claim ON claim.id = entry.source_claim_id
         LEFT JOIN LATERAL memory_subject_person(claim.subject_participant_id, claim.subject_user_id)
           AS subject_person ON true
         LEFT JOIN memory_item_refs AS memory_ref ON memory_ref.memory_item_id = claim.id
         LEFT JOIN confirmed_outcomes AS outcome ON outcome.id = entry.source_outcome_id
         LEFT JOIN LATERAL (
           SELECT evidence_kind, author_label_snapshot, observed_at
           FROM claim_evidence WHERE claim_id = claim.id AND evidence_role = 'primary'
           ORDER BY observed_at, id LIMIT 1
         ) AS source_evidence ON true
         LEFT JOIN memory_thread_entries AS cursor
           ON cursor.entry_ref = $6 AND cursor.thread_id = thread.id
         WHERE entry.thread_id = thread.id AND ($6::text IS NULL OR
           (entry.occurred_at, entry.entry_ref) < (cursor.occurred_at, cursor.entry_ref))
         ORDER BY entry.occurred_at DESC, entry.entry_ref DESC LIMIT $7
       ) AS history ON true
       ORDER BY history.occurred_at DESC NULLS LAST, history.entry_ref DESC NULLS LAST`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadRef,
        input.cursor ?? null, limit + 1],
    );
    const thread = result.rows[0];
    if (!thread) throw new AppError("AGENT_MEMORY_THREAD_NOT_FOUND", "Нить памяти не найдена");
    const entries: ModelMemoryThreadEntry[] = [];
    let totalCharacters = 0;
    for (const row of result.rows.slice(0, limit)) {
      if (row.entry_ref === null) continue;
      if (totalCharacters + row.content.length > THREAD_HISTORY_PAGE_MAX_CHARACTERS) break;
      const about = formatMemorySubjectPerson({
        name: row.subject_person_name,
        username: row.subject_person_username,
      });
      entries.push({
        ...(about === null ? {} : { about }),
        content: row.content,
        entryRef: row.entry_ref,
        occurredAt: row.occurred_at.toISOString(),
        role: row.role,
        sourceRef: row.source_ref,
        sourceEvidence: {
          authorLabel: row.source_author_label,
          kind: row.source_evidence_kind,
          observedAt: row.source_observed_at.toISOString(),
        },
        sourceType: row.source_type,
      });
      totalCharacters += row.content.length;
    }
    const historyRowCount = result.rows.filter((row) => row.entry_ref !== null).length;
    const hasMore = historyRowCount > entries.length && entries.length > 0;
    return {
      entries,
      nextCursor: hasMore ? entries.at(-1)!.entryRef : null,
      thread: toSummary(thread),
      totalCharacters,
    };
  },
};
