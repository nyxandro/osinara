/**
 * How much a record's age should cost it a place among the twelve.
 *
 * Exports:
 * - `MEMORY_RETENTION_BASE_DAYS`: how long each kind of record stays fully available.
 * - `memoryRetentionMultiplier`: the factor applied to a record's rank.
 *
 * Age used to be a bonus added to the score, and the number made it decorative: one branch match
 * at first place is worth about 0.0164, and the freshness bonus at most 0.0005 — three percent of
 * a single hit, fading over a year. A record from last week and one from last spring queued on
 * equal terms, and memory is growing fast: 39 records in July, 314 in August, 1112 in September.
 *
 * So age becomes a multiplier instead of a term: `R = exp(-age / S)`, and the rank is scaled by
 * `floor + (1 - floor) × R`. A multiplier makes the old record yield its place; the floor makes
 * sure it only yields it, never disappears. Nothing here removes anything, and the threshold
 * applies to the automatic selection alone — a deliberate search still sees the whole memory.
 *
 * Strength grows with use: `S = S0 × (1 + ln(1 + n))`. A record used four times lasts about 2.6
 * times longer than one never used. Today `n` is zero almost everywhere, because the signal that
 * feeds it only starts arriving with the directive introduced alongside this; until it does, the
 * curve is a function of age alone, and that is the honest description of what it does.
 */
import type { MemoryKind } from "./memory-record.js";

/**
 * An episode is about one moment and stops being the answer to anything once the moment passes;
 * a preference or a profile is a standing property of a person and ages far more slowly. The
 * numbers come from a neighbouring project running the same idea and are a starting point, not a
 * measurement of this family.
 */
export const MEMORY_RETENTION_BASE_DAYS: Record<MemoryKind, number> = {
  episode: 30,
  fact: 180,
  family_shared: 180,
  preference: 180,
  profile: 180,
};

/** How much of its rank a record keeps however old it is. Ageing decides order, not existence. */
export const MEMORY_RETENTION_FLOOR = 0.5;

export function memoryRetentionMultiplier(input: {
  ageDays: number;
  kind: MemoryKind;
  usageCount: number;
}): number {
  const age = Math.max(input.ageDays, 0);
  const uses = Math.max(input.usageCount, 0);
  const strength = MEMORY_RETENTION_BASE_DAYS[input.kind] * (1 + Math.log(1 + uses));
  const retention = Math.exp(-age / strength);
  return MEMORY_RETENTION_FLOOR + (1 - MEMORY_RETENTION_FLOOR) * retention;
}
