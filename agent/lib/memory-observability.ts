/**
 * Structured memory observability without query text, memory content, or participant identities.
 *
 * Export:
 * - `logMemoryWriteEvent`: emits aggregatable success/failure and thread-action events.
 * - `memorySelectionMetrics`: counts selected content and exposes only opaque record refs.
 * - `offeredMemoryEvidence`: where each offered item stood and how the search found it.
 */
import type { ModelMemoryContextItem } from "./memory-retrieval.js";
import type { MemoryRecordRanking } from "./memory-retrieval-ranking.js";

export function memorySelectionMetrics(memories: readonly ModelMemoryContextItem[] | null) {
  if (memories === null) return { memoryRefs: null, memoryCharacters: null, memorySerializedCharacters: null };
  const records = memories.flatMap<{ memoryRef: string; content: string }>(
    (item) => "versions" in item ? item.versions : [item],
  );
  return {
    memoryRefs: [...new Set(records.map((item) => item.memoryRef))],
    // Character metrics use JS UTF-16 units, like model-call metrics; they are not token counts.
    memoryCharacters: records.reduce((total, item) => total + item.content.length, 0),
    memorySerializedCharacters: JSON.stringify(memories).length,
  };
}

export type OfferedMemoryEvidence =
  | { memoryRef: string; position: number; ranking: MemoryRecordRanking | null }
  | { conflictRef: string; memoryRefs: string[]; position: number };

/**
 * Where each offered item stood and how the search found it, so a report can say which branch
 * the records the answer actually rested on came from and how high they sat.
 *
 * The position is the one the model reads the item at, counted after the block budget. An
 * unresolved conflict holds one place for both of its versions and carries no score: it enters
 * the selection as a closure of a found record, not on a rank of its own.
 *
 * A record the ranking does not describe is logged with `ranking: null` rather than dropped or
 * given numbers it never had: the report must see that the record was there and how it was found
 * is unknown, and a log field is not worth failing the person's memory over.
 */
export function offeredMemoryEvidence(
  memories: readonly ModelMemoryContextItem[],
  rankingByMemoryRef: ReadonlyMap<string, MemoryRecordRanking>,
): OfferedMemoryEvidence[] {
  return memories.map((item, index) => "versions" in item
    ? {
      conflictRef: item.conflictRef,
      memoryRefs: item.versions.map((version) => version.memoryRef),
      position: index + 1,
    }
    : {
      memoryRef: item.memoryRef,
      position: index + 1,
      ranking: rankingByMemoryRef.get(item.memoryRef) ?? null,
    });
}

export interface MemoryWriteEvent {
  /**
   * `DEFERRED` is a write the product stopped on purpose so the model would look at what is
   * already stored. It is counted apart from `FAILED` because it is not a fault: an alert that
   * mixed the two would fire on the assistant working exactly as designed.
   */
  code: "AGENT_MEMORY_WRITE_DEFERRED" | "AGENT_MEMORY_WRITE_FAILED" | "AGENT_MEMORY_WRITE_SUCCEEDED";
  errorCode?: string;
  scope: "family" | "group" | "personal";
  sourceKind: "current" | "delta";
  threadAction: "attach" | "attached" | "create" | "created" | "none";
}

export function logMemoryWriteEvent(event: MemoryWriteEvent): void {
  const serialized = JSON.stringify(event);
  if (event.code === "AGENT_MEMORY_WRITE_FAILED") {
    console.error(serialized);
    return;
  }
  console.info(serialized);
}
