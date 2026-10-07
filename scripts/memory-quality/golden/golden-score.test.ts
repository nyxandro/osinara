/**
 * Golden-set scoring tests.
 *
 * Constructs covered:
 * - Precision over what was offered, hit rate and recall over turns that had something to find,
 *   and the place of the first relevant record.
 * - A relevant record the selection missed is told apart: cut by a branch gate, passed the gates
 *   and lost the twelve places to others, or reached by no branch of the replay at all.
 * - A turn with nothing relevant anywhere counts toward abstention and toward precision, never
 *   toward hit rate, recall or rank.
 * - The model's own usage claims from the show journal are checked against the labels.
 * - A needed record no branch reached is counted against recall, and a turn whose only needed
 *   records lie outside the pool is named, since pooled recall would call it unanswerable.
 *   Recall with them is averaged per turn like recall without them, so it never comes out higher.
 * - An unlabelled pool record stops the score instead of counting as irrelevant; a label or an
 *   outside note that does not fit the pools, and a record offered twice, stop it too.
 * - Property: marking one more offered record relevant never lowers any quality number, and
 *   every share stays between 0 and 1.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { goldenTurn, labelledGoldenSet } from "./golden-turns.test-fixtures.js";
import { scoreGoldenSet } from "./golden-score.js";

const labels = (turnId: string, relevant: Record<string, boolean>) => ({
  relevant: new Map(Object.entries(relevant)), turnId,
});

describe("scoreGoldenSet", () => {
  it("scores what was offered against what was there to find", () => {
    const score = scoreGoldenSet([
      // c passed its gate and lost the places; d reached the pool only with the gates opened.
      goldenTurn({ gated: ["c"], offered: ["a", "b"], pool: ["c", "d"], turnId: "t1" }),
      goldenTurn({ offered: ["e", "f", "g", "h"], turnId: "t2" }),
    ], [
      labels("t1", { a: false, b: true, c: true, d: true }),
      labels("t2", { e: true, f: false, g: false, h: false }),
    ]);

    expect(score).toMatchObject({
      answerableTurns: 2,
      // t1: the first relevant record sat second; t2: first.
      meanReciprocalRank: (1 / 2 + 1) / 2,
      // t1: 1 of 2 offered; t2: 1 of 4.
      precisionAtOffered: { macro: (1 / 2 + 1 / 4) / 2, micro: 2 / 6 },
      // t1 found 1 of its 3 relevant records, t2 1 of 1.
      recallInPool: (1 / 3 + 1) / 2,
      hitRate: 1,
      missedRelevant: { cutByGate: 1, notReachedInReplay: 0, outranked: 1 },
      turns: 2,
    });
  });

  it("counts a record production showed but no replay branch reached apart from a gate cut", () => {
    const score = scoreGoldenSet([
      goldenTurn({ offered: ["a"], production: { shown: ["s"], used: [] }, turnId: "t1" }),
    ], [labels("t1", { a: false, s: true })]);

    expect(score.missedRelevant).toEqual({ cutByGate: 0, notReachedInReplay: 1, outranked: 0 });
  });

  it("counts a turn with nothing relevant toward abstention and precision, not toward hit rate", () => {
    const score = scoreGoldenSet([
      goldenTurn({ offered: [], pool: ["a"], turnId: "quiet" }),
      goldenTurn({ offered: ["b", "c"], turnId: "noisy" }),
    ], [labels("quiet", { a: false }), labels("noisy", { b: false, c: false })]);

    expect(score).toMatchObject({
      abstention: { emptyWhenNothingRelevant: 1 / 2, meanOfferedWhenNothingRelevant: 1, turns: 2 },
      answerableTurns: 0,
      hitRate: null,
      meanReciprocalRank: null,
      precisionAtOffered: { macro: 0, micro: 0 },
    });
  });

  it("checks the model's own usage claims against the labels", () => {
    const score = scoreGoldenSet([goldenTurn({
      offered: ["a"],
      production: { shown: ["a", "b", "c"], used: ["a", "c"] },
      turnId: "t1",
    })], [labels("t1", { a: true, b: true, c: false })]);

    expect(score.selfReport).toEqual({
      relevantShown: 2, relevantShownUsed: 1, turns: 1, used: 2, usedLabelledRelevant: 1,
    });
  });

  it("counts needed records the pool never reached against recall", () => {
    const score = scoreGoldenSet([
      goldenTurn({ offered: ["a", "b"], turnId: "t1" }),
      goldenTurn({ offered: ["c"], turnId: "t2" }),
    ], [labels("t1", { a: true, b: false }), labels("t2", { c: false })], new Map([
      ["t1", new Set(["x"])],
      ["t2", new Set(["y", "z"])],
    ]));

    // One relevant record offered out of four needed: a in the pool, x, y and z outside it.
    expect(score.neededOutsidePool).toEqual({
      hitRateIncludingOutside: 1 / 2, recallIncludingOutside: 1 / 4, records: 3, turnsWithOnlyOutside: 1,
    });
    expect(score.answerableTurns).toBe(1);
    // t2 needed memory and got none of it: a miss, not a turn where staying silent was right.
    expect(score.abstention.turns).toBe(0);
  });

  it("never reports recall with outside records above recall within the pool", () => {
    const relevantNine = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`r${index}`, true]));
    const score = scoreGoldenSet([
      goldenTurn({ offered: [], pool: ["miss"], turnId: "t1" }),
      goldenTurn({ offered: Object.keys(relevantNine), turnId: "t2" }),
    ], [labels("t1", { miss: true }), labels("t2", relevantNine)], new Map([["t2", new Set(["x"])]]));

    expect(score.recallInPool).toBe(1 / 2);
    expect(score.neededOutsidePool.recallIncludingOutside).toBe((0 + 9 / 10) / 2);
  });

  it("stops when the labels or outside notes were made for other pools", () => {
    const turns = [goldenTurn({ offered: ["a"], turnId: "t1" })];

    expect(() => scoreGoldenSet(turns, [labels("t1", { a: true, z: false })]))
      .toThrow(/AGENT_MEMORY_GOLDEN_LABEL_UNKNOWN/u);
    expect(() => scoreGoldenSet(turns, [labels("t1", { a: true }), labels("t9", { a: true })]))
      .toThrow(/AGENT_MEMORY_GOLDEN_LABEL_UNKNOWN/u);
    expect(() => scoreGoldenSet(turns, [labels("t1", { a: true })], new Map([["t9", new Set(["x"])]])))
      .toThrow(/AGENT_MEMORY_GOLDEN_OUTSIDE_UNKNOWN_TURN/u);
    expect(() => scoreGoldenSet(turns, [labels("t1", { a: true })], new Map([["t1", new Set(["a"])]])))
      .toThrow(/AGENT_MEMORY_GOLDEN_OUTSIDE_IN_POOL/u);
  });

  it("stops at a record offered twice instead of counting it twice", () => {
    const turn = goldenTurn({ offered: ["a"], turnId: "t1" });
    const doubled = { ...turn, offered: [...turn.offered, { memoryRef: "a", position: 2 }] };

    expect(() => scoreGoldenSet([doubled], [labels("t1", { a: true })])).toThrow(/AGENT_MEMORY_GOLDEN_POOLS_INVALID/u);
  });

  it("stops at an unlabelled pool record instead of counting it as irrelevant", () => {
    expect(() => scoreGoldenSet([goldenTurn({ offered: ["a", "b"], turnId: "t1" })], [labels("t1", { a: true })]))
      .toThrow(/AGENT_MEMORY_GOLDEN_LABEL_MISSING/u);
  });

  it("never lowers a quality number when one more offered record is marked relevant", () => {
    fc.assert(fc.property(labelledGoldenSet, fc.nat(), fc.nat(), ({ labels: given, turns }, turnPick, refPick) => {
      const before = scoreGoldenSet(turns, given);
      const turn = turns[turnPick % turns.length]!;
      const offered = turn.offered[refPick % Math.max(turn.offered.length, 1)];
      if (offered === undefined) return;
      const ownLabels = given.find((one) => one.turnId === turn.turnId)!.relevant;
      const wasAnswerable = [...ownLabels.values()].some(Boolean);
      const relabelled = given.map((one) => one.turnId !== turn.turnId ? one : {
        ...one, relevant: new Map([...one.relevant, [offered.memoryRef, true]]),
      });
      const after = scoreGoldenSet(turns, relabelled);

      for (const share of [after.precisionAtOffered.macro, after.precisionAtOffered.micro, after.hitRate,
        after.recallInPool, after.meanReciprocalRank]) {
        if (share !== null) expect(share).toBeGreaterThanOrEqual(0);
        if (share !== null) expect(share).toBeLessThanOrEqual(1);
      }
      // The relabelled record was offered, so both precision numbers exist before and after.
      for (const share of [before.precisionAtOffered.macro, before.precisionAtOffered.micro]) expect(share).not.toBeNull();
      expect(after.precisionAtOffered.micro!).toBeGreaterThanOrEqual(before.precisionAtOffered.micro!);
      expect(after.precisionAtOffered.macro!).toBeGreaterThanOrEqual(before.precisionAtOffered.macro!);
      // A turn that just became answerable joins hit rate and recall with a full hit, so they
      // cannot drop. It joins the reciprocal rank with 1 / its place, which may sit below the
      // mean: that number is only guaranteed not to fall for a turn that was already answerable.
      expect(after.hitRate ?? 0).toBeGreaterThanOrEqual(before.hitRate ?? 0);
      expect(after.recallInPool ?? 0).toBeGreaterThanOrEqual(before.recallInPool ?? 0);
      if (wasAnswerable) {
        expect(after.meanReciprocalRank ?? 0).toBeGreaterThanOrEqual(before.meanReciprocalRank ?? 0);
      }
    }));
  });
});
