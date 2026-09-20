/**
 * PostgreSQL hybrid long-term memory retrieval.
 *
 * Export:
 * - `memoryRetrievalRepository.search`: authorized thresholded active-claim retrieval plus
 *   log-only branch diagnostics measured in the same statement.
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
  MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_TERM_MATCHES,
  MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
  MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_TERM_MATCHES,
  MEMORY_RETRIEVAL_RECENCY_BOOST,
  MEMORY_RETRIEVAL_RECENCY_DECAY_SECONDS,
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
  type MemoryRetrievalBranchDiagnostics,
  type ScoredMemoryRetrievalResult,
} from "./memory-retrieval-ranking.js";

interface DiagnosticsColumns {
  russian_matched: number | string;
  russian_qualified: number | string;
  russian_top_rank: number | string | null;
  semantic_matched: number | string;
  semantic_qualified: number | string;
  semantic_top_similarity: number | string | null;
  simple_matched: number | string;
  simple_qualified: number | string;
  simple_top_rank: number | string | null;
}

interface RetrievalRow extends ReferencedMemoryRow {
  fused_score: number | string;
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

function vectorArrayLiterals(vectors: readonly (readonly number[])[]): string[] {
  if (vectors.length === 0) {
    throw new AppError(
      "AGENT_MEMORY_EMBEDDING_VECTOR_INVALID",
      "Не удалось выполнить смысловой поиск по памяти",
    );
  }
  return vectors.map(vectorLiteral);
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

/** A non-integer count means the statement's shape changed, not that a value is missing. */
function requiredCount(value: number | string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new AppError(
      "AGENT_MEMORY_RETRIEVAL_DIAGNOSTICS_INVALID",
      "Не удалось измерить работу поиска памяти. Повторите запрос",
    );
  }
  return count;
}

function rowToBranchDiagnostics(row: DiagnosticsColumns): MemoryRetrievalBranchDiagnostics {
  const russianQualified = requiredCount(row.russian_qualified);
  const semanticQualified = requiredCount(row.semantic_qualified);
  const simpleQualified = requiredCount(row.simple_qualified);
  return {
    // Only the word branches can hit it. The semantic branch asks the index for exactly that many
    // nearest chunks, so what it passes on is bounded by the limit rather than cut by it, and
    // including it here would make the flag say nothing.
    candidateLimitHit: [russianQualified, simpleQualified]
      .some((count) => count > MEMORY_RETRIEVAL_CANDIDATE_LIMIT),
    russianMatched: requiredCount(row.russian_matched),
    russianQualified,
    russianTopRank: optionalScore(row.russian_top_rank),
    semanticMatched: requiredCount(row.semantic_matched),
    semanticQualified,
    semanticTopSimilarity: optionalScore(row.semantic_top_similarity),
    simpleMatched: requiredCount(row.simple_matched),
    simpleQualified,
    simpleTopRank: optionalScore(row.simple_top_rank),
  };
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
    score: requiredScore(row.fused_score),
    sourceEvidence: {
      authorLabel: row.source_author_label,
      kind: row.source_evidence_kind,
      observedAt: row.source_observed_at.toISOString(),
    },
  };
}

/**
 * The one statement the semantic branch runs, exported so a test can read its plan from the same
 * text the product executes instead of from a copy that can drift away from it.
 */
export function memoryRetrievalSearchStatement(): string {
  return `WITH authorized AS NOT MATERIALIZED (
          SELECT item.*, ref.memory_ref
          FROM memory_items AS item
          JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
           WHERE item.family_id = $1 AND item.claim_status = 'active'
             AND ${authorizedClaimPredicate("item")}
       ),
       simple_lexemes AS (
         SELECT lexeme, positions
         FROM unnest(to_tsvector('simple', translate($5, 'ёЁ', 'еЕ')))
         WHERE ts_lexize('russian_stem', lexeme) <> '{}'
       ),
       russian_lexemes AS (
         SELECT lexeme, positions FROM unnest(to_tsvector('russian', $5))
       ),
       simple_query AS (
         SELECT array_agg(lexeme) AS terms,
                to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS query,
                (SELECT count(DISTINCT word)
                 FROM simple_lexemes AS counted, unnest(counted.positions) AS word) AS word_count
         FROM simple_lexemes
       ),
       russian_query AS (
         SELECT array_agg(lexeme) AS terms,
                to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS query,
                (SELECT count(DISTINCT word)
                 FROM russian_lexemes AS counted, unnest(counted.positions) AS word) AS word_count
         FROM russian_lexemes
       ),
       simple_matched AS (
         SELECT authorized.id, authorized.updated_at,
                ts_rank_cd(authorized.search_vector, simple_query.query) AS relevance,
                (SELECT count(DISTINCT word)
                 FROM simple_lexemes, unnest(simple_lexemes.positions) AS word
                 WHERE tsvector_to_array(authorized.search_vector) @> ARRAY[simple_lexemes.lexeme])
                  AS matched_terms,
                LEAST($7::bigint, simple_query.word_count) AS required_terms
         FROM authorized, simple_query
         WHERE simple_query.query IS NOT NULL
           AND authorized.search_vector @@ simple_query.query
       ),
       simple_evidence AS (
         SELECT id, updated_at, relevance
         FROM simple_matched
         WHERE matched_terms >= required_terms
         ORDER BY relevance DESC, updated_at DESC, id DESC
          LIMIT $6
        ),
       simple_lexical AS (
         SELECT id, relevance,
                row_number() OVER (ORDER BY relevance DESC, updated_at DESC, id DESC) AS ordinal
         FROM simple_evidence
       ),
       russian_matched AS (
         SELECT authorized.id, authorized.updated_at,
                ts_rank_cd(authorized.russian_search_vector, russian_query.query) AS relevance,
                (SELECT count(DISTINCT word)
                 FROM russian_lexemes, unnest(russian_lexemes.positions) AS word
                 WHERE tsvector_to_array(authorized.russian_search_vector)
                   @> ARRAY[russian_lexemes.lexeme]) AS matched_terms,
                LEAST($8::bigint, russian_query.word_count) AS required_terms
         FROM authorized, russian_query
         WHERE russian_query.query IS NOT NULL
           AND authorized.russian_search_vector @@ russian_query.query
       ),
       russian_evidence AS (
         SELECT id, updated_at, relevance
         FROM russian_matched
         WHERE matched_terms >= required_terms
         ORDER BY relevance DESC, updated_at DESC, id DESC
         LIMIT $6
       ),
       russian_morphology AS (
         SELECT id, relevance,
                row_number() OVER (ORDER BY relevance DESC, updated_at DESC, id DESC) AS ordinal
         FROM russian_evidence
       ),
       semantic_nearest AS (
         SELECT nearest.memory_item_id, nearest.distance
         FROM unnest($9::vector[]) AS query_vector,
         LATERAL (
           SELECT chunk.memory_item_id, chunk.embedding <=> query_vector AS distance
           FROM memory_embedding_chunks AS chunk
           WHERE chunk.embedding_model = $10
             AND EXISTS (
               SELECT 1 FROM authorized
               WHERE authorized.id = chunk.memory_item_id
                 AND authorized.embedding_status = 'indexed'
             )
           ORDER BY chunk.embedding <=> query_vector
           LIMIT $6
         ) AS nearest
       ),
       semantic_matched AS (
         SELECT authorized.id, authorized.updated_at,
                1 - MIN(semantic_nearest.distance) AS similarity
         FROM semantic_nearest
         JOIN authorized ON authorized.id = semantic_nearest.memory_item_id
         GROUP BY authorized.id, authorized.updated_at
       ),
       semantic_evidence AS (
         SELECT id, updated_at, similarity
         FROM semantic_matched
         WHERE similarity >= $11
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
       ),
       diagnostics AS (
         SELECT (SELECT max(relevance) FROM simple_matched) AS simple_top_rank,
                (SELECT max(relevance) FROM russian_matched) AS russian_top_rank,
                (SELECT max(similarity) FROM semantic_matched) AS semantic_top_similarity,
                (SELECT count(*) FROM simple_matched) AS simple_matched,
                (SELECT count(*) FROM russian_matched) AS russian_matched,
                (SELECT count(*) FROM semantic_matched) AS semantic_matched,
                (SELECT count(*) FROM simple_matched WHERE matched_terms >= required_terms)
                  AS simple_qualified,
                (SELECT count(*) FROM russian_matched WHERE matched_terms >= required_terms)
                  AS russian_qualified,
                (SELECT count(*) FROM semantic_matched
                  WHERE similarity >= $11
                  )
                  AS semantic_qualified
       )
       SELECT diagnostics.simple_top_rank, diagnostics.russian_top_rank,
              diagnostics.semantic_top_similarity, diagnostics.simple_matched,
              diagnostics.russian_matched, diagnostics.semantic_matched,
              diagnostics.simple_qualified, diagnostics.russian_qualified,
              diagnostics.semantic_qualified, ranked.*
       FROM diagnostics
       LEFT JOIN LATERAL (
       SELECT authorized.id, authorized.author_user_id, authorized.author_telegram_user_id,
              authorized.scope, authorized.kind, authorized.content, authorized.source,
               authorized.confirmation, authorized.sensitivity, authorized.message_thread_id,
               authorized.embedding_status, authorized.created_at, authorized.updated_at,
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
               (COALESCE(1.0 / ($12::double precision + simple_lexical.ordinal), 0) +
                COALESCE(1.0 / ($12::double precision + russian_morphology.ordinal), 0) +
                COALESCE(1.0 / ($12::double precision + semantic.ordinal), 0) +
                CASE WHEN authorized.confirmation = 'user_confirmed' THEN $13::double precision ELSE 0 END +
                $14::double precision / (1 + EXTRACT(EPOCH FROM (now() - authorized.updated_at)) / $15))
                 AS fused_score
       FROM candidates
       JOIN authorized USING (id)
       LEFT JOIN simple_lexical USING (id)
       LEFT JOIN russian_morphology USING (id)
       LEFT JOIN semantic USING (id)
       LEFT JOIN LATERAL (
          SELECT evidence_kind, observed_at, author_label_snapshot, origin_conversation_id,
                 author_user_id, author_participant_id, author_telegram_user_id
         FROM claim_evidence
         WHERE claim_id = authorized.id AND evidence_role = 'primary'
         ORDER BY observed_at, id LIMIT 1
       ) AS source_evidence ON true
       ) AS ranked ON true
       ORDER BY ranked.fused_score DESC NULLS LAST, ranked.updated_at DESC NULLS LAST,
                ranked.id DESC NULLS LAST`;
}

/** The parameters that statement takes, in its own order, so a test can bind them the same way. */
export function memoryRetrievalSearchParameters(
  auth: MemoryAuthorization,
  normalizedQuery: string,
  queryEmbeddings: readonly (readonly number[])[],
): unknown[] {
  return [
    auth.familyId,
    auth.scopes,
    auth.userId,
    auth.groupId,
    normalizedQuery,
    MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
    MEMORY_RETRIEVAL_MIN_SIMPLE_LEXICAL_TERM_MATCHES,
    MEMORY_RETRIEVAL_MIN_RUSSIAN_MORPHOLOGY_TERM_MATCHES,
    vectorArrayLiterals(queryEmbeddings),
    MEMORY_EMBEDDING_MODEL_VERSION,
    MEMORY_RETRIEVAL_MIN_SEMANTIC_SIMILARITY,
    MEMORY_RETRIEVAL_RRF_RANK_OFFSET,
    MEMORY_RETRIEVAL_CONFIRMATION_BOOST,
    MEMORY_RETRIEVAL_RECENCY_BOOST,
    MEMORY_RETRIEVAL_RECENCY_DECAY_SECONDS,
  ];
}

export const memoryRetrievalRepository = {
  async search(
    auth: MemoryAuthorization,
    query: string,
    queryEmbeddings: readonly (readonly number[])[],
    limit = MEMORY_RETRIEVAL_LIMIT,
  ): Promise<{
    diagnostics: MemoryRetrievalBranchDiagnostics;
    results: ScoredMemoryRetrievalResult[];
  }> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new AppError("AGENT_MEMORY_QUERY_INVALID", "Для поиска памяти нужен непустой запрос");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_RETRIEVAL_LIMIT) {
      throw new AppError("AGENT_MEMORY_LIMIT_INVALID", "Некорректный лимит поиска памяти");
    }

    // NOT MATERIALIZED keeps authorization in every inlined branch while allowing physical indexes.
    //
    // Both word branches build their condition as a disjunction of the query's own lexemes rather
    // than through `websearch_to_tsquery`, which joins every token with AND. A live question —
    // «Проверь, когда у меня ближайшее дежурство, и когда мы меняем резину» — then demanded that
    // one record contain all of those words at once, and no record ever does, so the branch
    // silently returned nothing and `ts_rank_cd` never got to do its job of ranking by how many
    // words matched and how close together they sit.
    //
    // The exact branch takes its terms from the same `to_tsvector('simple', ...)` that builds its
    // indexed column, so every term is a lexeme that column can actually hold, and then drops the
    // ones the Russian dictionary calls stop words — «и», «у», «за». With OR a stop word would
    // match nearly every record and drown the codes and names this branch exists for. The
    // morphological branch takes the stems its own configuration produced, where stop words are
    // already gone.
    //
    // Both branches then assemble their disjunction with `to_tsquery('simple', ...)`, which is not
    // a mistake: the terms are already lexemes of their own column, and the Russian configuration
    // would stem them a second time. «решен» becomes «реш», stops matching the column it came
    // from, and the branch goes quiet on a record that contains the word verbatim — the same
    // failure as the AND condition, one step lower.
    //
    // Words are counted by position, not by lexeme. One hyphenated token or a URL yields several
    // lexemes at the same position, and counting those as separate words would let a single
    // «e-mail» clear a gate that asks for two of the question's words.
    //
    // The semantic branch asks for the nearest chunks and only then folds them into records. That
    // order is what the vector index can serve: pgvector applies HNSW to «order by distance, take
    // n» and to nothing else, and the previous form hid the distance under MIN() with a GROUP BY,
    // so the index built on day one went unused by every query. The access rules stay inside the
    // lookup, as a condition on each chunk, and `hnsw.iterative_scan` — set on the database by
    // migration 107 — keeps the index handing over candidates until enough of them pass.
    //
    // It asks per piece of the query, not once for their average. A long message is cut into
    // chunks before embedding, and averaging them put the question about the roof and the question
    // about the medicine at a point that resembles neither.
    //
    // What this branch offers is the nearest chunks, so a record holding several of them takes
    // more than one place among them: at production's 1.16 chunks per record the forty nearest
    // chunks come from about thirty-four records rather than forty. With one query vector the set
    // is still exactly the closest records by their best chunk — if A's best chunk beats B's and
    // B made the forty, so did A. With several query vectors that is no longer guaranteed: a
    // record can arrive through a worse pair while its best pair missed that vector's forty, and
    // then its similarity is understated. It needs a record with many chunks crowded around one
    // vector, which the measured corpora do not produce.
    //
    // The branch CTEs are split in two on purpose: `*_matched` is what the branch found at all and
    // feeds the pre-threshold diagnostics, `*_evidence` is what survived the gate and the candidate
    // limit. Diagnostics are joined with LEFT JOIN LATERAL so an empty result still returns one row
    // carrying the numbers — an empty retrieval is exactly the case worth explaining.
    const result = await database().query<DiagnosticsColumns & ({ id: null } | RetrievalRow)>(
      memoryRetrievalSearchStatement(),
      memoryRetrievalSearchParameters(auth, normalizedQuery, queryEmbeddings),
    );
    // `diagnostics` is a SELECT without FROM and the join is LEFT LATERAL, so the statement always
    // returns at least this row. The guard exists to make a future edit that breaks that invariant
    // fail loudly instead of silently logging a search that was never measured.
    const head = result.rows[0];
    if (head === undefined) {
      throw new AppError(
        "AGENT_MEMORY_RETRIEVAL_DIAGNOSTICS_INVALID",
        "Не удалось измерить работу поиска памяти. Повторите запрос",
      );
    }
    const scored = result.rows
      .filter((row): row is DiagnosticsColumns & RetrievalRow => row.id !== null)
      .map(rowToScoredResult);
    return {
      diagnostics: rowToBranchDiagnostics(head),
      // Duplicate collapse is read-only and happens after global rank, keeping its representative.
      results: collapseExactDuplicateRetrievalResults(scored, limit),
    };
  },

  async searchWithConflictClosure(
    auth: MemoryAuthorization,
    query: string,
    queryEmbeddings: readonly (readonly number[])[],
    limit = MEMORY_RETRIEVAL_LIMIT,
  ): Promise<{
    conflicts: MemoryConflictGroup[];
    diagnostics: MemoryRetrievalBranchDiagnostics;
    relatedClaimIds: string[];
    results: ScoredMemoryRetrievalResult[];
  }> {
    const { diagnostics, results } = await memoryRetrievalRepository.search(
      auth,
      query,
      queryEmbeddings,
      limit,
    );
    const selectedIds = results.map((result) => result.memory.id);
    if (selectedIds.length === 0) return { conflicts: [], diagnostics, relatedClaimIds: [], results };

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
      diagnostics,
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
