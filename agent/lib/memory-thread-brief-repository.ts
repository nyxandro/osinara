/**
 * Activated memory-thread source context repository.
 *
 * Exports:
 * - `createMemoryThreadBriefRepository`: deterministic source-backed repository factory.
 * - `memoryThreadBriefRepository.activate`: selects authorized signals and budgets source records.
 * - `isThreadFinallyAuthorized`: final live barrier before a completed or active DTO is emitted.
 * - Source selection is delegated to `memory-thread-source-repository.ts`.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  THREAD_CONTEXT_EPISODES_PER_THREAD,
  THREAD_EPISODE_MAX_CHARACTERS,
  THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
  THREAD_CONTEXT_MAX_THREADS,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import {
  buildMemoryThreadBrief,
  type MemoryThreadBriefBlock,
} from "./memory-thread-brief-generator.js";
import {
  loadMemoryThreadSources,
  type ThreadSourceRow,
} from "./memory-thread-source-repository.js";
import { assembleMemoryThreadContext, type ActivatedMemoryThread, type MemoryThreadContext } from "./memory-thread-context.js";
import { loadMemoryThreadSourceEvidence } from "./memory-thread-source-evidence.js";

interface ActivatedThreadRow {
  id: string;
  purpose: string;
  retrieval_hits: number;
  skill_hint: boolean;
  status: "active" | "completed";
  thread_ref: string;
  title: string;
  title_similarity: number | string | null;
}

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

function titleSimilarity(value: number | string | null): number | null {
  if (value === null) return null;
  const similarity = Number(value);
  if (!Number.isFinite(similarity)) {
    throw new AppError(
      "AGENT_MEMORY_THREAD_SCORE_INVALID",
      "Не удалось проверить релевантность нити памяти",
    );
  }
  return similarity;
}

async function buildBrief(
  thread: ActivatedThreadRow,
  auth: MemoryAuthorization,
): Promise<MemoryThreadBriefBlock[]> {
  const sources = await loadMemoryThreadSources(database(), thread.id, auth);
  const sourceRecordByEntry = new Map(sources.map((source) => [source.ref, source.sourceRef]));
  return buildMemoryThreadBrief({ entries: sources }).map((block) => ({
    ...block,
    sourceRecordRefs: block.sourceEntryRefs.map((entryRef) => sourceRecordByEntry.get(entryRef)!),
  }));
}

async function loadEpisodes(
  threadId: string,
  auth: MemoryAuthorization,
): Promise<ActivatedMemoryThread["episodes"]> {
  const result = await database().query<ThreadSourceRow>(
    `SELECT entry.entry_ref, entry.role::text, entry.occurred_at,
            COALESCE(claim.content, outcome.summary) AS content,
            COALESCE(memory_ref.memory_ref, outcome.outcome_ref) AS source_ref
     FROM memory_thread_entries AS entry
     JOIN memory_threads AS thread ON thread.id = entry.thread_id
     LEFT JOIN memory_items AS claim ON claim.id = entry.source_claim_id
       AND claim.claim_status = 'active' AND claim.provenance_state = 'evidenced'
       AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)
     LEFT JOIN memory_item_refs AS memory_ref ON memory_ref.memory_item_id = claim.id
     LEFT JOIN confirmed_outcomes AS outcome ON outcome.id = entry.source_outcome_id AND outcome.status = 'confirmed'
     WHERE thread.family_id = $1
       AND ${liveMemoryReadPredicate({
         alias: "thread",
         personalIdentityColumn: "scope_partition_key",
       })}
       AND entry.thread_id = $5 AND entry.role = 'episode'
       AND char_length(COALESCE(claim.content, outcome.summary)) <= $6
     ORDER BY entry.occurred_at DESC, entry.id DESC LIMIT $7`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadId,
      THREAD_EPISODE_MAX_CHARACTERS, THREAD_CONTEXT_EPISODES_PER_THREAD],
  );
  return result.rows.map((row) => ({
    content: row.content,
    sourceEntryRefs: [row.entry_ref],
    sourceRecordRefs: [row.source_ref],
  }));
}

async function loadCompletionEpisode(threadId: string, auth: MemoryAuthorization) {
  const result = await database().query<{ entry_ref: string; outcome_ref: string; summary: string }>(
    `SELECT entry.entry_ref, outcome.outcome_ref, outcome.summary
     FROM memory_threads AS thread
     JOIN confirmed_outcomes AS outcome ON outcome.id = thread.completion_outcome_id
     JOIN memory_thread_entries AS entry ON entry.thread_id = thread.id
       AND entry.source_outcome_id = outcome.id
     WHERE thread.family_id = $1
       AND ${liveMemoryReadPredicate({
         alias: "thread",
         personalIdentityColumn: "scope_partition_key",
       })}
       AND thread.id = $5 AND thread.status = 'completed'`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadId],
  );
  const row = result.rows[0];
  return row ? {
    content: row.summary,
    sourceEntryRefs: [row.entry_ref],
    sourceRecordRefs: [row.outcome_ref],
  } : undefined;
}

async function isThreadFinallyAuthorized(
  threadId: string,
  auth: MemoryAuthorization,
): Promise<boolean> {
  const result = await database().query(
    `SELECT 1 FROM memory_threads AS thread
     WHERE thread.family_id = $1
       AND ${liveMemoryReadPredicate({
         alias: "thread",
         personalIdentityColumn: "scope_partition_key",
       })}
       AND thread.id = $5`,
    [auth.familyId, auth.scopes, auth.userId, auth.groupId, threadId],
  );
  return result.rows.length === 1;
}

export function createMemoryThreadBriefRepository() {
  return {
    async activate(input: {
    auth: MemoryAuthorization;
    /** Null when the embedding service was unreachable: threads then activate without similarity. */
    queryEmbedding: readonly number[] | null;
    retrievedClaimIds: readonly string[];
    skillHints: readonly string[];
  }): Promise<MemoryThreadContext> {
    const hints = [...new Set(input.skillHints.map((hint) =>
      hint.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru-RU")
    ))];
    const result = await database().query<ActivatedThreadRow>(
      `WITH hits AS (
         SELECT entry.thread_id, count(*)::integer AS retrieval_hits
         FROM memory_thread_entries AS entry
         JOIN memory_items AS claim ON claim.id = entry.source_claim_id
           AND claim.claim_status = 'active' AND claim.provenance_state = 'evidenced'
           AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = claim.id)
         WHERE entry.source_claim_id = ANY($5::uuid[]) GROUP BY entry.thread_id
       )
       SELECT thread.id, thread.thread_ref, thread.title, thread.purpose, thread.status::text,
               COALESCE(hits.retrieval_hits, 0) AS retrieval_hits,
              thread.title_normalized = ANY($7::text[]) AS skill_hint,
              CASE WHEN thread.title_embedding_model = $8
                THEN 1 - (thread.title_embedding <=> $6::vector) ELSE NULL END AS title_similarity
       FROM memory_threads AS thread LEFT JOIN hits ON hits.thread_id = thread.id
       WHERE thread.family_id = $1 AND ${liveMemoryReadPredicate({
          alias: "thread",
          personalIdentityColumn: "scope_partition_key",
        })} AND (thread.status = 'completed' OR EXISTS (
          SELECT 1 FROM memory_thread_entries AS available_entry
          LEFT JOIN memory_items AS available_claim ON available_claim.id = available_entry.source_claim_id
            AND available_claim.claim_status = 'active'
            AND available_claim.provenance_state = 'evidenced'
            AND EXISTS (SELECT 1 FROM claim_evidence WHERE claim_id = available_claim.id)
          LEFT JOIN confirmed_outcomes AS available_outcome
            ON available_outcome.id = available_entry.source_outcome_id
            AND available_outcome.status = 'confirmed'
          WHERE available_entry.thread_id = thread.id
            AND (available_claim.id IS NOT NULL OR available_outcome.id IS NOT NULL)
        )) AND (COALESCE(hits.retrieval_hits, 0) > 0 OR thread.title_normalized = ANY($7::text[])
         OR (thread.title_embedding_model = $8
           AND 1 - (thread.title_embedding <=> $6::vector) >= $9))
       ORDER BY skill_hint DESC,
                -- Without a query vector the comparison is NULL, and NULLs sort first under DESC:
                -- threads with a current title embedding would jump ahead of better-matching ones.
                COALESCE(thread.title_embedding_model = $8 AND
                  1 - (thread.title_embedding <=> $6::vector) >= $9, false) DESC,
                retrieval_hits DESC, thread.updated_at DESC
        LIMIT $10`,
      [input.auth.familyId, input.auth.scopes, input.auth.userId, input.auth.groupId,
        input.retrievedClaimIds,
        input.queryEmbedding === null ? null : vectorLiteral(input.queryEmbedding), hints,
         MEMORY_EMBEDDING_MODEL_VERSION, THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
         THREAD_CONTEXT_MAX_THREADS],
    );
    const activated: ActivatedMemoryThread[] = [];
    for (const thread of result.rows) {
      const similarity = titleSimilarity(thread.title_similarity);
      if (thread.status === "completed") {
        const completionEpisode = await loadCompletionEpisode(thread.id, input.auth);
        const sourceEvidence = await loadMemoryThreadSourceEvidence(
          database(),
          thread.id,
          input.auth,
        );
        // No content-bearing DTO is emitted if access changed during the preceding reads.
        if (!await isThreadFinallyAuthorized(thread.id, input.auth)) continue;
        activated.push({
          blocks: [],
          completionEpisode,
          episodes: [],
          purpose: thread.purpose,
          relevance: {
            retrievalHits: thread.retrieval_hits,
            skillHint: thread.skill_hint,
            titleMatch: similarity !== null && similarity >= THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
          },
          sourceEvidence,
          status: thread.status,
          threadRef: thread.thread_ref,
          title: thread.title,
        });
        continue;
      }
      const blocks = await buildBrief(thread, input.auth);
      const episodes = await loadEpisodes(thread.id, input.auth);
      const sourceEvidence = await loadMemoryThreadSourceEvidence(
        database(),
        thread.id,
        input.auth,
      );
      // Source reads are provisional until this final live check succeeds.
      if (!await isThreadFinallyAuthorized(thread.id, input.auth)) continue;
      activated.push({
        blocks,
        episodes,
        purpose: thread.purpose,
        relevance: {
          retrievalHits: thread.retrieval_hits,
          skillHint: thread.skill_hint,
          titleMatch: similarity !== null && similarity >= THREAD_TITLE_MIN_SEMANTIC_SIMILARITY,
        },
        sourceEvidence,
        status: thread.status,
        threadRef: thread.thread_ref,
        title: thread.title,
      });
    }
    return assembleMemoryThreadContext(activated);
    },
  };
}

export const memoryThreadBriefRepository = createMemoryThreadBriefRepository();
