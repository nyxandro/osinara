/**
 * Memory retention score: how accessible a record still is (not the soft-delete purge in memory-retention.ts).
 *
 * Exports:
 * - `memoryStabilityDays`: base stability by record kind.
 * - `memoryRetention`: R = exp(-age / S); age from the last reinforcement, event date, or creation.
 * - `retentionRankFactor`: multiplier for retrieval relevance; the floor keeps old records searchable.
 * - `isRetainedForAutomaticContext`: threshold that applies only to the automatic turn block.
 *
 * The SQL in `memory-retrieval-repository.ts` mirrors this formula; keep both in sync.
 */
import {
  MEMORY_AUTO_CONTEXT_MIN_RETENTION,
  MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE,
  MEMORY_RETENTION_RANK_FLOOR,
  MEMORY_STABILITY_DAYS_DISCUSSION_SUMMARY,
  MEMORY_STABILITY_DAYS_EPISODE,
  MEMORY_STABILITY_DAYS_SEMANTIC,
} from "./memory-config.js";
import type { MemoryKind } from "./memory-record.js";

const DAY_MILLISECONDS = 86_400_000;

export interface MemoryRetentionInput {
  attribute: string | null;
  createdAt: Date;
  kind: MemoryKind;
  lastReinforcedAt: Date | null;
  occurredAt: Date | null;
  reinforcementCount: number;
}

export function memoryStabilityDays(kind: MemoryKind, attribute: string | null): number {
  if (kind !== "episode") return MEMORY_STABILITY_DAYS_SEMANTIC;
  return attribute === MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE
    ? MEMORY_STABILITY_DAYS_DISCUSSION_SUMMARY
    : MEMORY_STABILITY_DAYS_EPISODE;
}

export function memoryRetention(input: MemoryRetentionInput, now: Date): number {
  const anchor = input.lastReinforcedAt ?? input.occurredAt ?? input.createdAt;
  const ageDays = Math.max(0, now.getTime() - anchor.getTime()) / DAY_MILLISECONDS;
  const stability = memoryStabilityDays(input.kind, input.attribute) *
    (1 + Math.log(1 + Math.max(0, input.reinforcementCount)));
  return Math.exp(-ageDays / stability);
}

export function retentionRankFactor(retention: number): number {
  return MEMORY_RETENTION_RANK_FLOOR + (1 - MEMORY_RETENTION_RANK_FLOOR) * retention;
}

export function isRetainedForAutomaticContext(retention: number): boolean {
  return retention >= MEMORY_AUTO_CONTEXT_MIN_RETENTION;
}
