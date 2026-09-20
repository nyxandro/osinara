/**
 * What is decided about a claim before the write transaction opens.
 *
 * Exports:
 * - `MemoryWriteGuards`: the checked slot, the checked event date, and the neighbour probe.
 * - `prepareMemoryWriteGuards`: runs all three, and refuses before anything is locked.
 *
 * Three things have to happen before `BEGIN`, for two different reasons. The slot name and the
 * event date are refusals, and a refusal must cost nothing — no transaction, no locks, no row.
 * The neighbour probe is a network call, and a network call inside a transaction holds the write
 * locks for exactly as long as the embedding service takes to answer.
 *
 * They live together here because they are one idea: everything the write decides about a claim
 * before it touches the database.
 */
import { normalizeMemoryAttribute } from "./memory-attribute-slot.js";
import { normalizeMemoryEventDate } from "./memory-event-window-repository.js";
import { embedMemoryNeighbourProbe } from "./memory-neighbour-gate.js";
import type { CreateMemoryInput } from "./memory-record.js";

export interface MemoryWriteGuards {
  attribute: string | null;
  neighbourProbe: number[] | null;
  occurredOn: string | null;
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
  const neighbourProbe = await embedMemoryNeighbourProbe({
    content: input.content,
    kind: input.kind,
    subjectLabel: input.explicitSource?.subject.kind === "label"
      ? input.explicitSource.subject.label
      : null,
  });
  return { attribute, neighbourProbe, occurredOn };
}
