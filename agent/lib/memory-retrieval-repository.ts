/**
 * PostgreSQL hybrid long-term memory retrieval.
 *
 * Export:
 * - `memoryRetrievalRepository.search`: scoped full-text plus pgvector reciprocal-rank fusion.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
  MEMORY_RETRIEVAL_LIMIT,
} from "./memory-config.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { MemoryItem, MemoryRow } from "./memory-record.js";
import { rowToMemory } from "./memory-record.js";

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

export const memoryRetrievalRepository = {
  async search(
    auth: MemoryAuthorization,
    query: string,
    queryEmbedding: readonly number[],
    limit = MEMORY_RETRIEVAL_LIMIT,
  ): Promise<MemoryItem[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new AppError("AGENT_MEMORY_QUERY_INVALID", "Для поиска памяти нужен непустой запрос");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_RETRIEVAL_LIMIT) {
      throw new AppError("AGENT_MEMORY_LIMIT_INVALID", "Некорректный лимит поиска памяти");
    }

    // Authorization is inside the materialized source CTE, before either retrieval branch ranks rows.
    const result = await database().query<MemoryRow & { fused_score: number }>(
      `WITH authorized AS MATERIALIZED (
         SELECT item.*
         FROM memory_items AS item
         WHERE item.family_id = $1
           AND (
             (item.scope = 'personal' AND 'personal' = ANY($2::memory_scope[]) AND item.owner_user_id = $3) OR
             (item.scope = 'family' AND 'family' = ANY($2::memory_scope[])) OR
             (item.scope = 'group' AND 'group' = ANY($2::memory_scope[]) AND item.group_id = $4)
           )
       ),
       full_text AS (
         SELECT id, row_number() OVER (
           ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('simple', $5)) DESC,
                    updated_at DESC, id DESC
         ) AS rank
         FROM authorized
         WHERE search_vector @@ websearch_to_tsquery('simple', $5)
         LIMIT $6
       ),
       semantic_distances AS (
         SELECT authorized.id, MIN(chunk.embedding <=> $7::vector) AS distance,
                authorized.updated_at
         FROM authorized
         JOIN memory_embedding_chunks AS chunk ON chunk.memory_item_id = authorized.id
         WHERE authorized.embedding_status = 'indexed' AND chunk.embedding_model = $8
         GROUP BY authorized.id, authorized.updated_at
       ),
       semantic AS (
         SELECT id, row_number() OVER (
            ORDER BY distance, updated_at DESC, id DESC
          ) AS rank
         FROM semantic_distances
         LIMIT $6
       ),
       candidates AS (
         SELECT id FROM full_text
         UNION
         SELECT id FROM semantic
       )
       SELECT authorized.id, authorized.author_user_id, authorized.author_telegram_user_id,
              authorized.scope, authorized.kind, authorized.content, authorized.source,
              authorized.confirmation, authorized.sensitivity, authorized.message_thread_id,
              authorized.embedding_status, authorized.created_at, authorized.updated_at,
              (COALESCE(1.0 / (60 + full_text.rank), 0) +
               COALESCE(1.0 / (60 + semantic.rank), 0) +
               CASE WHEN authorized.confirmation = 'user_confirmed' THEN 0.001 ELSE 0 END +
               0.0005 / (1 + EXTRACT(EPOCH FROM (now() - authorized.updated_at)) / 31557600))
                AS fused_score
       FROM candidates
       JOIN authorized USING (id)
       LEFT JOIN full_text USING (id)
       LEFT JOIN semantic USING (id)
       ORDER BY fused_score DESC, authorized.updated_at DESC, authorized.id DESC
       LIMIT $9`,
      [
        auth.familyId,
        auth.scopes,
        auth.userId,
        auth.groupId,
        normalizedQuery,
        MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
        vectorLiteral(queryEmbedding),
        MEMORY_EMBEDDING_MODEL_VERSION,
        limit,
      ],
    );
    return result.rows.map(rowToMemory);
  },
};
