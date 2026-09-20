/**
 * Showing the model what it is about to write next to, before it writes it.
 *
 * Exports:
 * - `MEMORY_NEIGHBOUR_SIMILARITY`: how close is close enough to be worth stopping for.
 * - `MEMORY_NEIGHBOUR_CANDIDATE_LIMIT`: how many neighbours the refusal may name.
 * - `MemoryNeighbourProbe`: the vector the gate compares with, or null when there is none.
 * - `memoryNeighbourProbePassage`: the text that vector is built from.
 * - `requireMemoryNeighbourDecision`: the gate itself, run inside the write transaction.
 * - `MemoryNeighbourRefusal`: the stop, which is a product outcome and not a failure.
 * - `memoryNeighbourRefusalResult`: what the model is answered with instead.
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
 * The gate can only see records the indexing worker has already reached, so two paraphrases
 * written inside one turn do not stop each other. That gap is covered from the other side: the
 * silent review is shown what the conversation already stores before it starts writing at all.
 *
 * The threshold is 0.93, measured rather than chosen: over 1030 active non-episode records on
 * production, a gate at 0.90 would stop 360 writes with 3.8 neighbours each, at 0.92 — 164, at
 * 0.93 — 100 with 1.3 neighbours, at 0.95 — 33. At 0.93 it stops about a tenth of writes, above
 * the band where different facts about one person live and at the bottom of the duplicate band.
 */
import type { PoolClient } from "pg";

import { chunkMemoryContent } from "./memory-embedding-chunks.js";
import { memoryEmbeddingInput } from "./memory-embedding-header.js";
import { MEMORY_EMBEDDING_MODEL_VERSION } from "./memory-config.js";
import type { MemoryKind } from "./memory-record.js";

const MEMORY_NEIGHBOUR_SIMILARITY = 0.93;
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
function memoryNeighbourGateApplies(kind: MemoryKind): boolean {
  return kind !== "episode";
}

/** The vector the gate compares with, or null when there is nothing to compare. */
export type MemoryNeighbourProbe = readonly number[] | null;

/**
 * The text the probe is built from, embedded the way the stored chunks are, header and all, or the
 * comparison would be measuring the header rather than the text. Only the opening chunk is used: a
 * rephrasing of a record shows there, and the whole check may spend one passage, not one per piece.
 */
export function memoryNeighbourProbePassage(input: {
  content: string;
  explicitSource?: { subject: { kind: string; label?: string } };
  kind: MemoryKind;
}): string | null {
  if (!memoryNeighbourGateApplies(input.kind)) return null;
  const opening = chunkMemoryContent(input.content)[0];
  if (opening === undefined) return null;
  return memoryEmbeddingInput(opening.content, {
    kind: input.kind,
    subjectLabel: input.explicitSource?.subject.kind === "label"
      ? input.explicitSource.subject.label ?? null
      : null,
  });
}

export async function requireMemoryNeighbourDecision(
  client: PoolClient,
  input: {
    declaredRefs: readonly string[];
    familyId: string;
    memoryProjectId: string | null;
    probe: MemoryNeighbourProbe;
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
       -- The refusal hands the model the text of what it found, so this query carries the family
       -- explicitly rather than trusting the partition to imply it.
       AND item.family_id = $2
       AND item.scope = $3::memory_scope AND item.scope_partition_key = $4
       AND item.memory_project_id IS NOT DISTINCT FROM $5
       AND item.subject_user_id IS NOT DISTINCT FROM $6
       AND item.subject_participant_id IS NOT DISTINCT FROM $7
       AND item.subject_conversation_id IS NOT DISTINCT FROM $8
       AND item.subject_label IS NOT DISTINCT FROM $9
       AND chunk.embedding_model = $10
     GROUP BY ref.memory_ref, item.content
     HAVING max(1 - (chunk.embedding <=> $1::vector)) >= $11
     ORDER BY similarity DESC
     LIMIT $12`,
    [
      `[${input.probe.join(",")}]`,
      input.familyId,
      input.scope,
      input.scopePartitionKey,
      input.memoryProjectId,
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

  throw new MemoryNeighbourRefusal(undeclared.map((row) => ({
    content: row.content,
    memoryRef: row.memory_ref,
  })));
}

/**
 * Not an error, however it travels. Stopping a write because the model should look at what is
 * already stored is the product working, and the neighbours it has to look at are memory content.
 * Thrown as its own class so the tool boundary can turn it into an ordinary answer: an error would
 * be logged by the framework with its whole payload, and the family's records would leave the
 * application for a log store with different retention and a different circle of access.
 */
export class MemoryNeighbourRefusal extends Error {
  /** The stable code, so a caller that only classifies failures reads this one like any other. */
  readonly code = "AGENT_MEMORY_SIMILAR_RECORD_EXISTS";

  constructor(readonly neighbours: readonly { content: string; memoryRef: string }[]) {
    // The message carries the code alone: the neighbours are memory content, and a message is the
    // part that ends up in a log when something up the stack decides this was a failure.
    super("AGENT_MEMORY_SIMILAR_RECORD_EXISTS");
    this.name = "MemoryNeighbourRefusal";
  }
}

/** The answer the model gets instead of the refusal, with the texts it has to read. */
export function memoryNeighbourRefusalResult(refusal: MemoryNeighbourRefusal) {
  return {
    code: "AGENT_MEMORY_SIMILAR_RECORD_EXISTS",
    correction: [
      "Прочитай эти записи и выбери одно из трёх.",
      "То же самое другими словами — не сохраняй заново; если новая формулировка точнее или полнее, обнови существующую через manage_memory action=edit.",
      "Другое свойство того же человека — задай attribute, короткое имя свойства, и сохрани как новую версию именно этого свойства.",
      "Действительно отдельное сведение — повтори вызов, перечислив в distinctFrom все memoryRef из этого списка.",
    ].join(" "),
    distinctFrom: refusal.neighbours.map((one) => one.memoryRef),
    reason: "В памяти уже есть близкие по смыслу записи о том же субъекте.",
    saved: false,
    similar: refusal.neighbours,
  };
}
