/**
 * Labelled real-turn candidate sets for the golden-set scoring tests.
 *
 * Exports:
 * - `goldenTurn`: one turn with what the selection offered, what passed the gates, and its pool.
 * - `labelledGoldenSet`: random turns with a relevance label for every pool record.
 *
 * Built the way the harness writes them: offered ⊆ gated, the offered refs and what the journal
 * showed are always in the pool, and the gated set reaches the pool only through the ungated
 * candidates — here, through `pool`. A record only the journal brought in was reached by no
 * branch of the replay.
 */
import fc from "fast-check";

import type { GoldenTurn } from "./golden-score.js";

export function goldenTurn(input: {
  gated?: readonly string[];
  offered: readonly string[];
  pool?: readonly string[];
  production?: { shown: readonly string[]; used: readonly string[] } | null;
  turnId: string;
}): GoldenTurn {
  const gated = [...new Set([...input.offered, ...input.gated ?? []])];
  const reached = new Set([...input.offered, ...input.pool ?? []]);
  const pool = [...new Set([...reached, ...input.production?.shown ?? []])];
  return {
    gated,
    message: `сообщение ${input.turnId}`,
    offered: input.offered.map((memoryRef, index) => ({ memoryRef, position: index + 1 })),
    pool: pool.map((memoryRef) => ({ branches: reached.has(memoryRef) ? ["simple"] : [], memoryRef })),
    production: input.production === undefined || input.production === null ? null : {
      shown: [...input.production.shown], used: [...input.production.used],
    },
    query: `вопрос ${input.turnId}`,
    turnId: input.turnId,
  };
}

const ref = (index: number) => `mem_${index.toString(16).padStart(32, "0")}`;

export const labelledGoldenSet = fc
  .array(fc.record({
    extraGated: fc.uniqueArray(fc.integer({ max: 19, min: 12 }), { maxLength: 4 }),
    // Overlaps the gated range: some gated records reach the pool through the ungated branches.
    extraPool: fc.uniqueArray(fc.integer({ max: 29, min: 12 }), { maxLength: 6 }),
    offered: fc.uniqueArray(fc.integer({ max: 11, min: 0 }), { maxLength: 12 }),
    relevant: fc.uniqueArray(fc.integer({ max: 29, min: 0 }), { maxLength: 8 }),
  }), { maxLength: 12, minLength: 1 })
  .map((shapes) => {
    const turns = shapes.map((shape, index) => goldenTurn({
      gated: shape.extraGated.map(ref),
      offered: shape.offered.map(ref),
      pool: shape.extraPool.map(ref),
      turnId: `turn_${index}`,
    }));
    const labels = turns.map((turn, index) => ({
      turnId: turn.turnId,
      relevant: new Map(turn.pool.map((record) => [
        record.memoryRef,
        shapes[index]!.relevant.map(ref).includes(record.memoryRef),
      ])),
    }));
    return { labels, turns };
  });
