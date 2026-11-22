/**
 * Explicit model-safe long-term memory contract.
 *
 * Exports:
 * - `MEMORY_REF_PATTERN`: validates opaque refs accepted at model-facing boundaries.
 * - `ModelMemory`: allowlisted DTO used by tools and automatic prompt retrieval.
 * - `ModelMemoryEvidence`: safe provenance attached to repository retrieval results.
 * - `EVIDENCE_KIND_LEGEND`: one shared explanation of every evidence kind.
 * - `MEMORY_ABOUT_LEGEND`: one shared explanation of `about`.
 * - `toModelMemory`: removes database, identity, source, thread, and indexing metadata, and names the
 *   person the record is bound to.
 *
 * The slot name travels with the record on purpose: the model has to see which property names a
 * subject already uses before it invents a new one, or two spellings of one property would both
 * stay active and the replacement rule would never fire.
 *
 * The person travels as `about`, not `subject`: `subject` is already the `{kind: …}` object the model
 * passes to `remember`, and one name for two shapes would invite it to send this string back there.
 * The person is a required argument, so a new way of showing records cannot forget to say whom they
 * are about; `null` is the answer for a record about nobody.
 *
 * Key construct:
 * - The provenance sentence is a pure function of the evidence kind, so it is stated once per
 *   block instead of being repeated on every record and every profile claim.
 */
import type { MemoryScope } from "./memory-context.js";
import { formatMemorySubjectPerson, type MemorySubjectPerson } from "./memory-subject-person.js";
import type {
  MemoryConfirmation,
  MemoryItem,
  MemoryKind,
  MemorySensitivity,
  ReferencedMemoryItem,
} from "./memory-record.js";

export const MEMORY_REF_PATTERN = /^mem_[0-9a-f]{32}$/u;

export interface ModelMemory {
  /** The person the record is bound to, as Telegram names them now: «Имя (@username)». */
  about?: string;
  /** Name of the property this record holds, so the model can see which slots already exist. */
  attribute?: string;
  authorStatus: ReferencedMemoryItem["author"]["status"];
  confirmation: MemoryConfirmation;
  content: string;
  createdAt: string;
  kind: MemoryKind;
  memoryRef: string;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
  /** Present only when this is not the current version of its property. */
  status?: MemoryItem["status"];
  /** The day the event happened, when it is known; absent means only the day it was written. */
  occurredOn?: string;
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
  "Meaning of evidence kind: firsthand is a direct statement by the verified author of the source; " +
  "reported was told by another participant and is not a confirmation by the subject; " +
  "inferred was derived by the model from the source and is not a direct statement by the subject; " +
  "explicit was explicitly saved by the user; unresolved means the provenance is not established.";

/** Stated once per block, beside the evidence legend: what `about` is and why it outranks the text. */
export const MEMORY_ABOUT_LEGEND =
  "`about` is whom a record is bound to, stated by the server from the person's Telegram identity with their " +
  "current name and username; trust it over a name or username inside the text, which may be outdated, " +
  "belong to a namesake or be missing.";

export function toModelMemory(
  memory: ReferencedMemoryItem,
  person: MemorySubjectPerson | null,
  evidence?: ModelMemoryEvidence,
): ModelMemory {
  const about = person === null ? null : formatMemorySubjectPerson(person);
  // Build from an explicit allowlist so future internal fields cannot leak by object spreading.
  return {
    ...(about === null ? {} : { about }),
    ...(memory.attribute === null ? {} : { attribute: memory.attribute }),
    authorStatus: memory.author.status,
    confirmation: memory.confirmation,
    content: memory.content,
    createdAt: memory.createdAt,
    kind: memory.kind,
    memoryRef: memory.memoryRef,
    scope: memory.scope,
    sensitivity: memory.sensitivity,
    ...(memory.status === undefined ? {} : { status: memory.status }),
    ...(memory.occurredOn === null ? {} : { occurredOn: memory.occurredOn }),
    ...(memory.updatedAt === memory.createdAt ? {} : { updatedAt: memory.updatedAt }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}
