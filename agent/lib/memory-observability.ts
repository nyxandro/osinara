/**
 * Structured memory observability without query text, memory content, or participant identities.
 *
 * Export:
 * - `logMemoryWriteEvent`: emits aggregatable success/failure and thread-action events.
 * - `memorySelectionMetrics`: counts selected content and exposes only opaque record refs.
 */
import type { ModelMemoryContextItem } from "./memory-retrieval.js";

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

export interface MemoryWriteEvent {
  code: "AGENT_MEMORY_WRITE_FAILED" | "AGENT_MEMORY_WRITE_SUCCEEDED";
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
