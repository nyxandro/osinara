/**
 * Explicit model-safe long-term memory contract.
 *
 * Exports:
 * - `MEMORY_REF_PATTERN`: validates opaque refs accepted at model-facing boundaries.
 * - `ModelMemory`: allowlisted DTO used by tools and automatic prompt retrieval.
 * - `ModelMemoryEvidence`: safe provenance attached to repository retrieval results.
 * - `EVIDENCE_KIND_LEGEND`: one shared explanation of every evidence kind.
 * - `toModelMemory`: removes database, identity, source, thread, and indexing metadata.
 *
 * Key construct:
 * - The provenance sentence is a pure function of the evidence kind, so it is stated once per
 *   block instead of being repeated on every record and every profile claim.
 */
import type { MemoryScope } from "./memory-context.js";
import type {
  MemoryConfirmation,
  MemoryKind,
  MemorySensitivity,
  ReferencedMemoryItem,
} from "./memory-record.js";

export const MEMORY_REF_PATTERN = /^mem_[0-9a-f]{32}$/u;

export interface ModelMemory {
  authorStatus: ReferencedMemoryItem["author"]["status"];
  confirmation: MemoryConfirmation;
  content: string;
  createdAt: string;
  kind: MemoryKind;
  memoryRef: string;
  occurredAt: string | null;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  /** Present only when the record actually changed after it was written. */
  updatedAt?: string;
  evidence?: ModelMemoryEvidence;
}

export interface ModelMemoryEvidence {
  authorLabel: string;
  kind: "firsthand" | "inferred" | "reported" | "unresolved";
  observedAt: string;
}

export const EVIDENCE_KIND_LEGEND =
  "Значение evidence kind: firsthand это прямое заявление проверенного автора источника; " +
  "reported это сообщено другим участником и не является подтверждением субъекта; " +
  "inferred это выведено моделью из источника и не является прямым заявлением субъекта; " +
  "explicit это явно сохранено пользователем; unresolved это происхождение не установлено.";

export function toModelMemory(
  memory: ReferencedMemoryItem,
  evidence?: ModelMemoryEvidence,
): ModelMemory {
  // Build from an explicit allowlist so future internal fields cannot leak by object spreading.
  return {
    authorStatus: memory.author.status,
    confirmation: memory.confirmation,
    content: memory.content,
    createdAt: memory.createdAt,
    kind: memory.kind,
    memoryRef: memory.memoryRef,
    occurredAt: memory.occurredAt,
    scope: memory.scope,
    sensitivity: memory.sensitivity,
    ...(memory.updatedAt === memory.createdAt ? {} : { updatedAt: memory.updatedAt }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}
