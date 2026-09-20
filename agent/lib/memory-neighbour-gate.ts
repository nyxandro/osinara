/**
 * Showing the model what it is about to write next to, before it writes it.
 *
 * Exports:
 * - `MEMORY_NEIGHBOUR_SIMILARITY`: how close is close enough to be worth stopping for.
 * - `MEMORY_NEIGHBOUR_CANDIDATE_LIMIT`: how many neighbours the refusal may name.
 * - `embedMemoryNeighbourProbe`: the vector the gate compares with, or null when it cannot.
 * - `requireMemoryNeighbourDecision`: the gate itself, run inside the write transaction.
 *
 * Saving a claim checks only for an identical string today, so «Аня не ест глютен» and «у Ани
 * непереносимость глютена» become two records. Nobody sees the second one appear, but both queue
 * for the same twelve slots and both count against the quota.
 *
 * **The code never merges anything by itself.** The measurement in #208 is the reason: on the same
 * embedding model, real duplicates sit at about 0.934 and genuinely different facts about one
 * person at 0.916–0.924, and those ranges touch. Any threshold that catches every duplicate also
 * glues together separate facts, and they would disappear without a word. So the threshold decides
 * one thing only — whether the model is shown the neighbours — and the model, which can read both
 * texts and the conversation, decides what they are.
 *
 * Getting through is deliberate and specific: the model repeats the refs it was shown in
 * `distinctFrom`. A neighbour it has not named stops the write again, so a blanket declaration
 * carried over from an earlier turn cannot wave through something new.
 *
 * The threshold is 0.93, measured rather than chosen: over 1030 active non-episode records on
 * production, a gate at 0.90 would stop 360 writes with 3.8 neighbours each, at 0.92 — 164, at
 * 0.93 — 100 with 1.3 neighbours, at 0.95 — 33. At 0.93 it stops about a tenth of writes, above
 * the band where different facts about one person live and at the bottom of the duplicate band.
 */
import type { PoolClient } from "pg";

import { chunkMemoryContent } from "./memory-embedding-chunks.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { memoryEmbeddingInput } from "./memory-embedding-header.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import type { MemoryKind } from "./memory-record.js";
import { ModelFacingError } from "./model-facing-error.js";

export const MEMORY_NEIGHBOUR_SIMILARITY = 0.93;
export const MEMORY_NEIGHBOUR_CANDIDATE_LIMIT = 5;

interface NeighbourRow {
  content: string;
  memory_ref: string;
  similarity: number | string;
}

/**
 * An episode is about one moment, and two similar trips are two trips; repeats there are the
 * normal shape of the data, not a defect, so the gate never looks at them.
 */
export function memoryNeighbourGateApplies(kind: MemoryKind): boolean {
  return kind !== "episode";
}

/**
 * The probe is embedded the way the stored chunks are, header and all, or the comparison would be
 * measuring the header rather than the text. Only the opening chunk is used: a rephrasing of a
 * record shows there, and one call per write is the whole budget this check may spend.
 *
 * A failure returns null on purpose. This is a helper check, and an embedding service that is down
 * must never cost the person a memory; the write then behaves exactly as it did before the gate.
 */
export async function embedMemoryNeighbourProbe(input: {
  content: string;
  kind: MemoryKind;
  subjectLabel: string | null;
}): Promise<number[] | null> {
  if (!memoryNeighbourGateApplies(input.kind)) return null;
  const opening = chunkMemoryContent(input.content)[0];
  if (opening === undefined) return null;
  try {
    const embeddings = await embedMemoryPassages([
      memoryEmbeddingInput(opening.content, {
        kind: input.kind,
        subjectLabel: input.subjectLabel,
      }),
    ]);
    return embeddings[0] ?? null;
  } catch {
    return null;
  }
}

export async function requireMemoryNeighbourDecision(
  client: PoolClient,
  input: {
    declaredRefs: readonly string[];
    probe: number[] | null;
    scope: string;
    scopePartitionKey: string;
    subjectConversationId: string | null;
    subjectLabel: string | null;
    subjectParticipantId: string | null;
    subjectUserId: string | null;
  },
): Promise<void> {
  if (input.probe === null) return;
  const neighbours = await client.query<NeighbourRow>(
    `SELECT ref.memory_ref, item.content,
            max(1 - (chunk.embedding <=> $1::vector)) AS similarity
     FROM memory_embedding_chunks AS chunk
     JOIN memory_items AS item ON item.id = chunk.memory_item_id
     JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
     WHERE item.claim_status = 'active' AND item.kind <> 'episode'
       AND item.scope = $2::memory_scope AND item.scope_partition_key = $3
       AND item.subject_user_id IS NOT DISTINCT FROM $4
       AND item.subject_participant_id IS NOT DISTINCT FROM $5
       AND item.subject_conversation_id IS NOT DISTINCT FROM $6
       AND item.subject_label IS NOT DISTINCT FROM $7
       AND chunk.embedding_model = $8
     GROUP BY ref.memory_ref, item.content
     HAVING max(1 - (chunk.embedding <=> $1::vector)) >= $9
     ORDER BY similarity DESC
     LIMIT $10`,
    [
      `[${input.probe.join(",")}]`,
      input.scope,
      input.scopePartitionKey,
      input.subjectUserId,
      input.subjectParticipantId,
      input.subjectConversationId,
      input.subjectLabel,
      MEMORY_EMBEDDING_MODEL_VERSION,
      MEMORY_NEIGHBOUR_SIMILARITY,
      MEMORY_NEIGHBOUR_CANDIDATE_LIMIT,
    ],
  );
  const undeclared = neighbours.rows
    .filter((row) => !input.declaredRefs.includes(row.memory_ref));
  if (undeclared.length === 0) return;

  const listed = undeclared
    .map((row) => `${row.memory_ref}: «${row.content}»`)
    .join("; ");
  throw new ModelFacingError({
    category: "conflict",
    code: "AGENT_MEMORY_SIMILAR_RECORD_EXISTS",
    correction: [
      "Прочитай эти записи и выбери одно из трёх.",
      "То же самое другими словами — не сохраняй заново; если новая формулировка точнее или полнее, обнови существующую через manage_memory action=edit.",
      "Другое свойство того же человека — задай attribute, короткое имя свойства, и сохрани как новую версию именно этого свойства.",
      "Действительно отдельное сведение — повтори вызов, перечислив в distinctFrom все memoryRef из этого списка.",
    ].join(" "),
    example: { distinctFrom: undeclared.map((row) => row.memory_ref) },
    field: "content",
    reason: `В памяти уже есть близкие по смыслу записи о том же субъекте: ${listed}`,
    retryable: true,
    sideEffectStatus: "not_started",
  });
}
