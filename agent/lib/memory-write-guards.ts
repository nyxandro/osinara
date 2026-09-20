/**
 * What is decided about a claim before the write transaction opens.
 *
 * Exports:
 * - `MemoryWriteGuards`: the checked slot, the checked event date, and both embeddings.
 * - `prepareMemoryWriteGuards`: runs all of it, and refuses before anything is locked.
 *
 * Three things have to happen before `BEGIN`, for two different reasons. The slot name and the
 * event date are refusals, and a refusal must cost nothing — no transaction, no locks, no row.
 * The embeddings are network calls, and a network call inside a transaction holds the write locks
 * for exactly as long as the service takes to answer.
 *
 * Both passages go in one request. A thread title and a neighbour probe are the same kind of text
 * to the embedding service, and sending them separately would double the number of round trips a
 * single claim costs — the extra call is what #208 counted as its price, and it does not have to
 * be paid twice.
 *
 * The two failures are not the same, and the split is deliberate. A title that cannot be embedded
 * stops the write: the thread would be created without the vector its own duplicate check needs.
 * A probe that cannot be embedded is written to the log and the write goes on, because a helper
 * check must never cost the person a memory.
 */
import { normalizeMemoryAttribute } from "./memory-attribute-slot.js";
import { embedMemoryPassages } from "./memory-embedding-client.js";
import { normalizeMemoryEventDate } from "./memory-event-window-repository.js";
import { memoryFailureCode } from "./memory-context-failure.js";
import {
  memoryNeighbourProbePassage,
  type MemoryNeighbourProbe,
} from "./memory-neighbour-gate.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { requireMemoryThreadTitle } from "./memory-thread-write.js";

export interface MemoryWriteGuards {
  attribute: string | null;
  neighbourProbe: MemoryNeighbourProbe;
  occurredOn: string | null;
  threadTitleEmbedding: readonly number[] | null;
}

export async function prepareMemoryWriteGuards(
  input: CreateMemoryInput,
): Promise<MemoryWriteGuards> {
  const attribute = input.attribute === undefined
    ? null
    : normalizeMemoryAttribute(input.attribute, input.kind);
  const occurredOn = input.occurredOn === undefined
    ? null
    : normalizeMemoryEventDate(input.occurredOn);
  const title = requireMemoryThreadTitle(input.thread);
  const probe = memoryNeighbourProbePassage(input);
  const passages = [
    ...(title === null ? [] : [title]),
    ...(probe === null ? [] : [probe]),
  ];
  if (passages.length === 0) {
    return { attribute, neighbourProbe: null, occurredOn, threadTitleEmbedding: null };
  }
  try {
    const embeddings = await embedMemoryPassages(passages);
    return {
      attribute,
      neighbourProbe: probe === null ? null : embeddings[title === null ? 0 : 1] ?? null,
      occurredOn,
      threadTitleEmbedding: title === null ? null : embeddings[0] ?? null,
    };
  } catch (error) {
    // A thread cannot be created without its title vector, so that failure is the write's failure.
    if (title !== null) throw error;
    // Written down once: a gate that quietly stopped working looks exactly like a memory where
    // nothing is ever a duplicate, and nobody would notice for weeks.
    console.warn(JSON.stringify({
      code: "AGENT_MEMORY_NEIGHBOUR_PROBE_SKIPPED",
      causeCode: memoryFailureCode(error) ?? "UNCLASSIFIED_EMBEDDING_ERROR",
      kind: input.kind,
    }));
    return { attribute, neighbourProbe: null, occurredOn, threadTitleEmbedding: null };
  }
}
