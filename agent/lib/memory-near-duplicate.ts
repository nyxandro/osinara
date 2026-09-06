/**
 * Near-duplicate gate at memory write time.
 *
 * Exports:
 * - `findNearDuplicateClaims`: active records of the same subject whose embedding is close to
 *   the candidate content; bounded to a few candidates.
 * - `nearDuplicateError`: the model-facing refusal that lists the candidates and the three ways
 *   to proceed (`reinforces`, `attribute`, `distinct`).
 *
 * The prod embedder keeps distinct facts about one subject above the threshold too, so the gate
 * never merges on its own: the model that is already writing decides.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import {
  MEMORY_EMBEDDING_MODEL_VERSION,
  MEMORY_NEAR_DUPLICATE_CANDIDATES,
  MEMORY_NEAR_DUPLICATE_SIMILARITY,
  MEMORY_SEMANTIC_KINDS,
} from "./memory-config.js";
import type { MemoryAuthorization, MemoryScope } from "./memory-context.js";
import type { MemoryKind } from "./memory-record.js";

export interface NearDuplicateCandidate {
  attribute: string | null;
  content: string;
  memoryRef: string;
  similarity: number;
}

export interface FindNearDuplicateClaimsInput {
  embedding: readonly number[];
  kind: MemoryKind;
  scope: MemoryScope;
  scopePartitionKey: string;
  subjectLabel: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
}

export function isSemanticMemoryKind(kind: MemoryKind): boolean {
  return (MEMORY_SEMANTIC_KINDS as readonly string[]).includes(kind);
}

export async function findNearDuplicateClaims(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: FindNearDuplicateClaimsInput,
): Promise<NearDuplicateCandidate[]> {
  if (!isSemanticMemoryKind(input.kind)) return [];
  const result = await client.query<{
    attribute: string | null;
    content: string;
    memory_ref: string;
    similarity: number | string;
  }>(
    `SELECT ref.memory_ref, item.content, item.attribute,
            MAX(1 - (chunk.embedding <=> $5::vector)) AS similarity
       FROM memory_items AS item
       JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
       JOIN memory_embedding_chunks AS chunk
         ON chunk.memory_item_id = item.id AND chunk.embedding_model = $6
      WHERE item.family_id = $1 AND item.scope = $2 AND item.scope_partition_key = $3
        AND item.claim_status = 'active' AND item.deleted_at IS NULL
        AND item.embedding_status = 'indexed'
        AND item.kind = ANY($4::memory_kind[])
        AND item.subject_participant_id IS NOT DISTINCT FROM $7::uuid
        AND item.subject_user_id IS NOT DISTINCT FROM $8::uuid
        AND item.subject_label IS NOT DISTINCT FROM $9::text
      GROUP BY ref.memory_ref, item.content, item.attribute, item.created_at, item.id
     HAVING MAX(1 - (chunk.embedding <=> $5::vector)) >= $10
      ORDER BY similarity DESC, item.created_at DESC, item.id DESC
      LIMIT $11`,
    [auth.familyId, input.scope, input.scopePartitionKey, [...MEMORY_SEMANTIC_KINDS],
      `[${input.embedding.join(",")}]`, MEMORY_EMBEDDING_MODEL_VERSION,
      input.subjectParticipantId, input.subjectUserId, input.subjectLabel,
      MEMORY_NEAR_DUPLICATE_SIMILARITY, MEMORY_NEAR_DUPLICATE_CANDIDATES],
  );
  return result.rows.map((row) => ({
    attribute: row.attribute,
    content: row.content,
    memoryRef: row.memory_ref,
    similarity: Number(row.similarity),
  }));
}

export function nearDuplicateError(candidates: readonly NearDuplicateCandidate[]): AppError {
  const listed = candidates.map(({ attribute, content, memoryRef }) => ({ attribute, content, memoryRef }));
  return new AppError(
    "AGENT_MEMORY_NEAR_DUPLICATE",
    `Похожие записи уже есть: ${JSON.stringify(listed)}. ` +
      "Если это то же самое, повтори remember с reinforces=memoryRef; если факт изменился, повтори с attribute " +
      "(или исправь через manage_memory edit); если это другой факт, повтори с distinct=true.",
  );
}
