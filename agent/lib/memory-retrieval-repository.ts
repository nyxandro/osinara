/**
 * PostgreSQL hybrid long-term memory retrieval.
 *
 * Export:
 * - `memoryRetrievalRepository.search`: authorized thresholded active-claim retrieval.
 * - `memoryRetrievalRepository.searchWithConflictClosure`: score-independent complete conflict groups.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
  MEMORY_RETRIEVAL_CONFIRMATION_BOOST,
  MEMORY_RETRIEVAL_LIMIT,
  MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_RANK,
  MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
  MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_RANK,
  MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE,
  MEMORY_RETENTION_RANK_FLOOR,
  MEMORY_STABILITY_DAYS_DISCUSSION_SUMMARY,
  MEMORY_STABILITY_DAYS_EPISODE,
  MEMORY_STABILITY_DAYS_SEMANTIC,
  MEMORY_RETRIEVAL_RRF_RANK_OFFSET,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { liveMemoryReadPredicate } from "./memory-live-read-authorization.js";
import type { ReferencedMemoryRow } from "./memory-record.js";
import { rowToReferencedMemory } from "./memory-record.js";
import { externalProfileProjectionPredicate } from "./external-profile-projection-predicate.js";
import type { ModelMemoryEvidence } from "./model-memory.js";
import {
  collapseExactDuplicateRetrievalResults,
  type ScoredMemoryRetrievalResult,
} from "./memory-retrieval-ranking.js";

interface RetrievalRow extends ReferencedMemoryRow {
  fused_score: number | string;
  retention: number | string;
  memory_project_id: string | null;
  russian_morphology_rank: number | string | null;
  semantic_similarity: number | string | null;
  simple_lexical_rank: number | string | null;
  scope_partition_key: string;
  source_author_label: string;
  source_author_participant_id: string | null;
  source_author_telegram_user_id: string | null;
  source_author_user_id: string | null;
  source_evidence_kind: ModelMemoryEvidence["kind"];
  source_observed_at: Date;
  source_origin_conversation_id: string | null;
  subject_family_id: string | null;
  subject_label: string | null;
  subject_participant_id: string | null;
  subject_user_id: string | null;
}

export interface MemoryConflictVersion {
  content: string;
  evidenceKind: "explicit" | "firsthand" | "inferred" | "reported" | "unresolved";
  memoryRef: string;
  observedAt: string;
  sourceLabel: string;
}

export interface MemoryConflictGroup {
  conflictRef: string;
  instruction: "Не выбирать версию самостоятельно";
  versions: [MemoryConflictVersion, MemoryConflictVersion];
}

interface ConflictClosureRow {
  a_id: string;
  a_content: string;
  a_evidence_kind: MemoryConflictVersion["evidenceKind"];
  a_memory_ref: string;
  a_observed_at: Date;
  a_source_label: string;
  b_id: string;
  b_content: string;
  b_evidence_kind: MemoryConflictVersion["evidenceKind"];
  b_memory_ref: string;
  b_observed_at: Date;
  b_source_label: string;
  conflict_ref: string;
}

function vectorLiteral(vector: readonly number[]): string {
  if (
    vector.length !== MEMORY_EMBEDDING_DIMENSIONS ||
    !vector.every((value) => Number.isFinite(value))
  ) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_VECTOR_INVALID",
      "Не удалось выполнить смысловой поиск по памяти",
    );
  }
  return `[${vector.join(",")}]`;
}

function authorizedClaimPredicate(alias: "a" | "b" | "item" | "partner"): string {
  // The projection branch is deliberately part of the pre-ranking predicate. Exact participant
  // linkage and the live policy admit only the current private user's normal self claims; an
  // external turn has no personal scope and therefore remains confined to its own group branch.
  return liveMemoryReadPredicate({
    alias,
    externalProjectionPredicate: externalProfileProjectionPredicate({
      claimAlias: alias,
      viewerUserParameter: "$3",
    }),
    personalIdentityColumn: "owner_user_id",
  });
}

function requiredScore(value: number | string): number {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    throw new AppError(
      "AGENT_MEMORY_RETRIEVAL_SCORE_INVALID",
      "Не удалось проверить релевантность результатов поиска памяти. Повторите запрос",
    );
  }
  return score;
}

function optionalScore(value: number | string | null): number | null {
  return value === null ? null : requiredScore(value);
}

function rowToScoredResult(row: RetrievalRow): ScoredMemoryRetrievalResult {
  return {
    evidence: {
      russianMorphologyRank: optionalScore(row.russian_morphology_rank),
      semanticSimilarity: optionalScore(row.semantic_similarity),
      simpleLexicalRank: optionalScore(row.simple_lexical_rank),
    },
    exactDuplicateIdentity: JSON.stringify([
      row.scope,
      row.scope_partition_key,
      row.subject_family_id,
      row.subject_user_id,
      row.subject_participant_id,
      row.memory_project_id,
      row.subject_label?.normalize("NFKC").toLocaleLowerCase("ru-RU") ?? null,
      row.source_evidence_kind,
      row.source_origin_conversation_id,
      row.source_author_user_id,
      row.source_author_participant_id,
      row.source_author_telegram_user_id,
    ]),
    memory: rowToReferencedMemory(row),
    retention: requiredScore(row.retention),
    score: requiredScore(row.fused_score),
    sourceEvidence: {
      authorLabel: row.source_author_label,
      kind: row.source_evidence_kind,
      observedAt: row.source_observed_at.toISOString(),
    },
  };
}

/** Optional inclusive date window over the event date, falling back to creation time. */
export interface MemoryRetrievalWindow {
  occurredAfter?: string;
  occurredBefore?: string;
}

export const memoryRetrievalRepository = {
  async search(
    auth: MemoryAuthorization,
    query: string,
    queryEmbedding: readonly number[],
    limit = MEMORY_RETRIEVAL_LIMIT,
    window: MemoryRetrievalWindow = {},
  ): Promise<ScoredMemoryRetrievalResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new AppError("AGENT_MEMORY_QUERY_INVALID", "Для поиска памяти нужен непустой запрос");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_RETRIEVAL_LIMIT) {
      throw new AppError("AGENT_MEMORY_LIMIT_INVALID", "Некорректный лимит поиска памяти");
    }

    // NOT MATERIALIZED keeps authorization in every inlined branch while allowing physical indexes.
    const result = await database().query<RetrievalRow>(
      `WITH authorized AS NOT MATERIALIZED (
          SELECT item.*, ref.memory_ref
          FROM memory_items AS item
          JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
           WHERE item.family_id = $1 AND item.claim_status = 'active'
             AND ${authorizedClaimPredicate("item")}
             AND ($19::timestamptz IS NULL OR COALESCE(item.occurred_at, item.created_at) >= $19::timestamptz)
             AND ($20::timestamptz IS NULL OR COALESCE(item.occurred_at, item.created_at) <= $20::timestamptz)
       ),
       simple_evidence AS (
         SELECT id, updated_at, relevance
         FROM (
           SELECT id, updated_at,
                  ts_rank_cd(search_vector, websearch_to_tsquery('simple', $5)) AS relevance
           FROM authorized
           WHERE search_vector @@ websearch_to_tsquery('simple', $5)
         ) AS matched
         WHERE relevance >= $7
         ORDER BY relevance DESC, updated_at DESC, id DESC
          LIMIT $6
        ),
       simple_lexical AS (
         SELECT id, relevance,
                row_number() OVER (ORDER BY relevance DESC, updated_at DESC, id DESC) AS ordinal
         FROM simple_evidence
       ),
       russian_evidence AS (
         SELECT id, updated_at, relevance
         FROM (
           SELECT id, updated_at,
                  ts_rank_cd(russian_search_vector, websearch_to_tsquery('russian', $5)) AS relevance
           FROM authorized
           WHERE russian_search_vector @@ websearch_to_tsquery('russian', $5)
         ) AS matched
         WHERE relevance >= $8
         ORDER BY relevance DESC, updated_at DESC, id DESC
         LIMIT $6
       ),
       russian_morphology AS (
         SELECT id, relevance,
                row_number() OVER (ORDER BY relevance DESC, updated_at DESC, id DESC) AS ordinal
         FROM russian_evidence
       ),
       semantic_distances AS (
         SELECT authorized.id, MIN(chunk.embedding <=> $9::vector) AS distance,
                 authorized.updated_at
         FROM authorized
         JOIN memory_embedding_chunks AS chunk ON chunk.memory_item_id = authorized.id
         WHERE authorized.embedding_status = 'indexed' AND chunk.embedding_model = $10
         GROUP BY authorized.id, authorized.updated_at
        ),
       semantic_evidence AS (
         SELECT id, updated_at, 1 - distance AS similarity
         FROM semantic_distances
         WHERE 1 - distance >= $11
         ORDER BY similarity DESC, updated_at DESC, id DESC
         LIMIT $6
       ),
       semantic AS (
         SELECT id, similarity,
                row_number() OVER (ORDER BY similarity DESC, updated_at DESC, id DESC) AS ordinal
         FROM semantic_evidence
       ),
       candidates AS (
         SELECT id FROM simple_lexical
         UNION
         SELECT id FROM russian_morphology
         UNION
         SELECT id FROM semantic
       )
       SELECT authorized.id, authorized.author_user_id, authorized.author_telegram_user_id,
              authorized.scope, authorized.kind, authorized.content, authorized.source,
               authorized.confirmation, authorized.sensitivity, authorized.message_thread_id,
               authorized.embedding_status, authorized.created_at, authorized.updated_at, authorized.occurred_at,
               authorized.memory_ref, authorized.scope_partition_key, authorized.subject_family_id,
               authorized.subject_user_id, authorized.subject_participant_id,
               authorized.memory_project_id, authorized.subject_label,
               simple_lexical.relevance AS simple_lexical_rank,
               russian_morphology.relevance AS russian_morphology_rank,
                semantic.similarity AS semantic_similarity,
                 COALESCE(source_evidence.evidence_kind, 'unresolved') AS source_evidence_kind,
                 COALESCE(source_evidence.observed_at, authorized.created_at) AS source_observed_at,
                 COALESCE(source_evidence.author_label_snapshot, 'Источник не установлен') AS source_author_label,
                 COALESCE(source_evidence.origin_conversation_id, authorized.origin_conversation_id)
                   AS source_origin_conversation_id,
                 COALESCE(source_evidence.author_user_id, authorized.author_user_id)
                   AS source_author_user_id,
                 source_evidence.author_participant_id AS source_author_participant_id,
                 COALESCE(source_evidence.author_telegram_user_id,
                          authorized.author_telegram_user_id) AS source_author_telegram_user_id,
               retention.value AS retention,
               ((COALESCE(1.0 / ($12::double precision + simple_lexical.ordinal), 0) +
                 COALESCE(1.0 / ($12::double precision + russian_morphology.ordinal), 0) +
                 COALESCE(1.0 / ($12::double precision + semantic.ordinal), 0))
                  * ($14::double precision + (1 - $14::double precision) * retention.value)
                + CASE WHEN authorized.confirmation = 'user_confirmed' THEN $13::double precision ELSE 0 END)
                 AS fused_score
       FROM candidates
       JOIN authorized USING (id)
       LEFT JOIN simple_lexical USING (id)
       LEFT JOIN russian_morphology USING (id)
       LEFT JOIN semantic USING (id)
       -- Retention R = exp(-age / S) mirrors memory-retention.ts: age from the last reinforcement,
       -- else the event date, else creation; S widens with reinforcement.
       CROSS JOIN LATERAL (
         SELECT exp(
           - GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(authorized.last_reinforced_at, authorized.occurred_at, authorized.created_at)))) / 86400.0
           / ((CASE WHEN authorized.kind = 'episode'
                    THEN CASE WHEN authorized.attribute = $18::text THEN $16::double precision ELSE $15::double precision END
                    ELSE $17::double precision END)
              * (1 + ln(1 + GREATEST(0, authorized.reinforcement_count))))
         ) AS value
       ) AS retention
       LEFT JOIN LATERAL (
          SELECT evidence_kind, observed_at, author_label_snapshot, origin_conversation_id,
                 author_user_id, author_participant_id, author_telegram_user_id
         FROM claim_evidence
         WHERE claim_id = authorized.id AND evidence_role = 'primary'
         ORDER BY observed_at, id LIMIT 1
       ) AS source_evidence ON true
       ORDER BY fused_score DESC, authorized.updated_at DESC, authorized.id DESC`,
      [
        auth.familyId,
        auth.scopes,
        auth.userId,
        auth.groupId,
        normalizedQuery,
        MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
        MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_RANK,
        MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_RANK,
        vectorLiteral(queryEmbedding),
        MEMORY_EMBEDDING_MODEL_VERSION,
        MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
        MEMORY_RETRIEVAL_RRF_RANK_OFFSET,
        MEMORY_RETRIEVAL_CONFIRMATION_BOOST,
        MEMORY_RETENTION_RANK_FLOOR,
        MEMORY_STABILITY_DAYS_EPISODE,
        MEMORY_STABILITY_DAYS_DISCUSSION_SUMMARY,
        MEMORY_STABILITY_DAYS_SEMANTIC,
        MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE,
        window.occurredAfter ?? null,
        window.occurredBefore ?? null,
      ],
    );
    // Duplicate collapse is read-only and happens after global rank, preserving its representative.
    return collapseExactDuplicateRetrievalResults(result.rows.map(rowToScoredResult), limit);
  },

  async searchWithConflictClosure(
    auth: MemoryAuthorization,
    query: string,
    queryEmbedding: readonly number[],
    limit = MEMORY_RETRIEVAL_LIMIT,
    window: MemoryRetrievalWindow = {},
  ): Promise<{
    conflicts: MemoryConflictGroup[];
    relatedClaimIds: string[];
    results: ScoredMemoryRetrievalResult[];
  }> {
    const results = await memoryRetrievalRepository.search(auth, query, queryEmbedding, limit, window);
    const selectedIds = results.map((result) => result.memory.id);
    if (selectedIds.length === 0) return { conflicts: [], relatedClaimIds: [], results };

    // Detect an inaccessible partner without selecting any partner content or metadata. Opaque refs
    // are capabilities, not authorization: one visible side of an unresolved conflict is withheld.
    const blocked = await database().query<{ selected_claim_id: string }>(
      `SELECT DISTINCT selected.id AS selected_claim_id
       FROM unnest($5::uuid[]) AS selected(id)
       JOIN claim_conflicts AS conflict
         ON selected.id IN (conflict.claim_a_id, conflict.claim_b_id)
       JOIN memory_items AS partner ON partner.id = CASE
         WHEN conflict.claim_a_id = selected.id THEN conflict.claim_b_id ELSE conflict.claim_a_id END
       WHERE conflict.family_id = $1 AND conflict.resolution = 'unresolved'
         AND NOT COALESCE(
           partner.claim_status = 'active' AND ${authorizedClaimPredicate("partner")},
           false
         )`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId, selectedIds],
    );
    const blockedIds = new Set(blocked.rows.map((row) => row.selected_claim_id));

    // Both sides pass the full authorization predicate in one statement. An inaccessible partner
    // suppresses the complete group rather than leaking only the selected side.
    const closure = await database().query<ConflictClosureRow>(
      `SELECT conflict.conflict_ref, a.id AS a_id, b.id AS b_id,
              a.content AS a_content, ref_a.memory_ref AS a_memory_ref,
              COALESCE(evidence_a.evidence_kind::text, 'unresolved') AS a_evidence_kind,
              COALESCE(evidence_a.observed_at, a.created_at) AS a_observed_at,
              CASE WHEN evidence_a.id IS NULL THEN 'Источник не установлен'
                   ELSE concat_ws(' · ', evidence_a.author_label_snapshot,
                                      evidence_a.origin_conversation_label_snapshot) END AS a_source_label,
              b.content AS b_content, ref_b.memory_ref AS b_memory_ref,
              COALESCE(evidence_b.evidence_kind::text, 'unresolved') AS b_evidence_kind,
              COALESCE(evidence_b.observed_at, b.created_at) AS b_observed_at,
              CASE WHEN evidence_b.id IS NULL THEN 'Источник не установлен'
                   ELSE concat_ws(' · ', evidence_b.author_label_snapshot,
                                      evidence_b.origin_conversation_label_snapshot) END AS b_source_label
       FROM claim_conflicts AS conflict
       JOIN memory_items AS a ON a.id = conflict.claim_a_id
       JOIN memory_items AS b ON b.id = conflict.claim_b_id
       JOIN memory_item_refs AS ref_a ON ref_a.memory_item_id = a.id
       JOIN memory_item_refs AS ref_b ON ref_b.memory_item_id = b.id
       LEFT JOIN LATERAL (
         SELECT id, evidence_kind, observed_at, author_label_snapshot,
                origin_conversation_label_snapshot
         FROM claim_evidence WHERE claim_id = a.id AND evidence_role = 'primary'
         ORDER BY observed_at, id LIMIT 1
       ) AS evidence_a ON true
       LEFT JOIN LATERAL (
         SELECT id, evidence_kind, observed_at, author_label_snapshot,
                origin_conversation_label_snapshot
         FROM claim_evidence WHERE claim_id = b.id AND evidence_role = 'primary'
         ORDER BY observed_at, id LIMIT 1
       ) AS evidence_b ON true
       WHERE conflict.family_id = $1 AND conflict.resolution = 'unresolved'
         AND a.claim_status = 'active' AND b.claim_status = 'active'
         AND (a.id = ANY($5::uuid[]) OR b.id = ANY($5::uuid[]))
          AND ${authorizedClaimPredicate("a")}
          AND ${authorizedClaimPredicate("b")}
       ORDER BY conflict.conflict_ref`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId, selectedIds],
    );
    const completeClosure = closure.rows.filter((row) =>
      !blockedIds.has(row.a_id) && !blockedIds.has(row.b_id)
    );

    // Reauthorize every possible output claim after all closure reads. This final barrier removes
    // unrelated base candidates too, while retaining a conflict only when both versions survive.
    const outputClaimIds = [...new Set([
      ...selectedIds,
      ...completeClosure.flatMap((row) => [row.a_id, row.b_id]),
    ])];
    const finalAuthorization = await database().query<{
      has_unresolved_conflict: boolean;
      id: string;
    }>(
      `SELECT item.id,
              EXISTS (
                SELECT 1 FROM claim_conflicts AS item_conflict
                WHERE item_conflict.family_id = $1
                  AND item_conflict.resolution = 'unresolved'
                  AND item.id IN (item_conflict.claim_a_id, item_conflict.claim_b_id)
              ) AS has_unresolved_conflict
       FROM memory_items AS item
       WHERE item.family_id = $1 AND item.claim_status = 'active'
         AND item.id = ANY($5::uuid[])
         AND ${authorizedClaimPredicate("item")}
         AND NOT EXISTS (
           SELECT 1
           FROM claim_conflicts AS final_conflict
           JOIN memory_items AS partner ON partner.id = CASE
             WHEN final_conflict.claim_a_id = item.id THEN final_conflict.claim_b_id
             ELSE final_conflict.claim_a_id END
           WHERE final_conflict.family_id = $1
             AND final_conflict.resolution = 'unresolved'
             AND item.id IN (final_conflict.claim_a_id, final_conflict.claim_b_id)
             AND NOT COALESCE(
               partner.claim_status = 'active' AND ${authorizedClaimPredicate("partner")},
               false
             )
         )`,
      [auth.familyId, auth.scopes, auth.userId, auth.groupId, outputClaimIds],
    );
    const finalAuthorizedIds = new Set(finalAuthorization.rows.map((row) => row.id));
    const finalOrdinaryIds = new Set(finalAuthorization.rows
      .filter((row) => !row.has_unresolved_conflict)
      .map((row) => row.id));
    const finalClosure = completeClosure.filter((row) =>
      finalAuthorizedIds.has(row.a_id) && finalAuthorizedIds.has(row.b_id)
    );
    const conflicts = finalClosure.map((row): MemoryConflictGroup => ({
      conflictRef: row.conflict_ref,
      instruction: "Не выбирать версию самостоятельно",
      versions: [{
        content: row.a_content,
        evidenceKind: row.a_evidence_kind,
        memoryRef: row.a_memory_ref,
        observedAt: row.a_observed_at.toISOString(),
        sourceLabel: row.a_source_label,
      }, {
        content: row.b_content,
        evidenceKind: row.b_evidence_kind,
        memoryRef: row.b_memory_ref,
        observedAt: row.b_observed_at.toISOString(),
        sourceLabel: row.b_source_label,
      }],
    }));
    return {
      conflicts,
      relatedClaimIds: [...new Set([
        ...results.filter((result) => !blockedIds.has(result.memory.id))
          .filter((result) => finalOrdinaryIds.has(result.memory.id))
          .map((result) => result.memory.id),
        ...finalClosure.flatMap((row) => [row.a_id, row.b_id]),
      ])],
      results: results.filter((result) =>
        finalOrdinaryIds.has(result.memory.id) && !blockedIds.has(result.memory.id)
      ),
    };
  },
};
