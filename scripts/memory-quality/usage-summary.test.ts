/**
 * Memory usage report tests.
 *
 * Constructs covered:
 * - A record named in a progress note and again in the final answer is one use, not two: the
 *   line-level count that read 3.6% where the per-turn truth was 3.1% is pinned here.
 * - Where each used record sat and which branches had found it.
 * - A named ref the turn never showed is traced to the profile, an explicit search, an earlier
 *   turn of the session — its block, profile or search — or nowhere.
 * - Lines from before the release that writes these fields are counted and left out.
 * - A malformed line, or a current one missing a field it always carries, stops the report with
 *   its number instead of being read as zeros.
 * - Properties: the order of the exported lines and repeated lines change nothing; the numbers
 *   agree with what the stream was built to contain, whatever noise surrounds it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  conflictEntry,
  memoryLogScenario,
  recordEntry,
  ref,
  searchLine,
  selectionLine,
  usageLine,
} from "./usage-lines.test-fixtures.js";
import { summarizeMemoryUsage } from "./usage-summary.js";

const turn = { sessionId: "session-1", turnId: "turn_1" };

describe("summarizeMemoryUsage", () => {
  it("counts a record named in a progress note and again in the final answer once", () => {
    const summary = summarizeMemoryUsage([
      selectionLine({ ...turn, characters: 3_000, time: "2026-10-07T10:00:00.000Z", evidence: [
        recordEntry(1, ref(1), ["simple", "semantic"]),
        recordEntry(2, ref(2), ["semantic"]),
        recordEntry(3, ref(3), ["russian"]),
      ] }),
      usageLine({ ...turn, declared: true, finishReason: "tool-calls",
        time: "2026-10-07T10:00:01.000Z", usedRefs: [ref(2)] }),
      usageLine({ ...turn, declared: true, finishReason: "stop",
        time: "2026-10-07T10:00:05.000Z", usedRefs: [ref(2), ref(3)] }),
    ]);

    expect(summary.usage).toMatchObject({
      answeredTurns: 1,
      characters: { offered: 3_000, perUsed: 1_500 },
      finalAnswers: { declared: 1, total: 1 },
      meanReciprocalRank: 0.5,
      offered: 3,
      used: 2,
      usedByPosition: { 2: 1, 3: 1 },
      turnsWithUse: 1,
    });
    expect(summary.usage.byBranch).toEqual({
      conflict: { offered: 0, used: 0 },
      semantic_only: { offered: 1, used: 1 },
      unknown: { offered: 0, used: 0 },
      words_and_semantic: { offered: 1, used: 0 },
      words_only: { offered: 1, used: 1 },
    });
  });

  it("traces each named ref the turn never showed to where the model could have seen it", () => {
    const earlier = { sessionId: "session-1", turnId: "turn_0" };
    const summary = summarizeMemoryUsage([
      selectionLine({ ...earlier, evidence: [recordEntry(1, ref(9), ["semantic"])],
        time: "2026-10-07T09:00:00.000Z" }),
      selectionLine({ ...turn, evidence: [conflictEntry(1, "conflict_1", [ref(1), ref(2)])],
        profileRefs: [ref(5)], time: "2026-10-07T10:00:00.000Z" }),
      searchLine({ ...turn, refs: [ref(6)], time: "2026-10-07T10:00:01.000Z" }),
      usageLine({ ...turn, declared: true, finishReason: "stop", time: "2026-10-07T10:00:02.000Z",
        rejectedRefs: [ref(5), ref(6), ref(9), ref(7)], usedRefs: [ref(2)] }),
    ]);

    expect(summary.usage.rejected).toEqual({ inProfile: 1, inSearch: 1, shownEarlier: 1, unknown: 1 });
    expect(summary.usage.byBranch.conflict).toEqual({ offered: 2, used: 1 });
    expect(summary.usage.searches).toEqual({ calls: 1, records: 1 });
  });

  it("traces a ref an earlier turn's search showed to that turn, not to nowhere", () => {
    const earlier = { sessionId: "session-1", turnId: "turn_0" };
    const summary = summarizeMemoryUsage([
      // The earlier turn had no tracked selection of its own: an approval continuation searches too.
      searchLine({ ...earlier, refs: [ref(6)], time: "2026-10-07T09:00:00.000Z" }),
      selectionLine({ ...turn, evidence: [], profileRefs: [], time: "2026-10-07T10:00:00.000Z" }),
      usageLine({ ...turn, declared: true, finishReason: "stop", time: "2026-10-07T10:00:02.000Z",
        rejectedRefs: [ref(6)] }),
      // The same ref shown only after it was named explains nothing.
      searchLine({ ...earlier, refs: [ref(7)], time: "2026-10-07T11:00:00.000Z" }),
      usageLine({ ...turn, declared: true, finishReason: "stop", time: "2026-10-07T10:00:03.000Z",
        rejectedRefs: [ref(7)] }),
    ]);

    expect(summary.usage.rejected).toEqual({ inProfile: 0, inSearch: 0, shownEarlier: 1, unknown: 1 });
  });

  it("says how many lines predate the fields it reads and leaves them out", () => {
    const legacySelection = selectionLine({ ...turn, evidence: [], time: "2026-10-01T10:00:00.000Z" });
    delete legacySelection.usageTracked;
    const legacyUsage = usageLine({ ...turn, declared: true, finishReason: "stop",
      time: "2026-10-01T10:00:01.000Z" });
    delete legacyUsage.finishReason;

    // A search by query from before the release carries no evidence, and one by period has a window.
    const legacySearch = searchLine({ ...turn, refs: [ref(1)], time: "2026-10-01T10:00:02.000Z" });
    delete legacySearch.memoryEvidence;
    const periodSearch = { ...legacySearch, "window.from": "2026-09-01", _time: "2026-10-07T10:00:00.000Z" };

    const summary = summarizeMemoryUsage([legacySelection, legacyUsage, legacySearch, periodSearch]);

    expect(summary.input).toEqual({ duplicates: 0, legacy: 3, lines: 4, usageWithoutSelection: 0 });
    expect(summary.usage.searches).toEqual({ calls: 1, records: 1 });
    expect(summary.usage).toMatchObject({ offered: 0, selections: { empty: 0, tracked: 0 } });
  });

  it("stops at a malformed line and names it instead of skipping it", () => {
    const broken = { ...selectionLine({ ...turn, evidence: [], time: "2026-10-07T10:00:00.000Z" }),
      memoryEvidence: "[{" };

    expect(() => summarizeMemoryUsage([broken])).toThrow(/AGENT_MEMORY_USAGE_REPORT_LINE_INVALID.*строку 1 /u);
  });

  it("stops at a current line missing a field it always carries instead of reading it as zero", () => {
    const selection = selectionLine({ ...turn, evidence: [], time: "2026-10-07T10:00:00.000Z" });
    const usage = usageLine({ ...turn, declared: true, finishReason: "stop", time: "2026-10-07T10:00:01.000Z" });
    delete usage.usedRefs;

    expect(() => summarizeMemoryUsage([selection, usage]))
      .toThrow(/AGENT_MEMORY_USAGE_REPORT_LINE_INVALID.*строке 2 .*usedRefs/u);
  });

  it("reads the same numbers from any order of the lines and from repeated lines", () => {
    fc.assert(fc.property(
      memoryLogScenario.map(({ lines }) => lines).chain((lines) => fc.tuple(
        fc.constant(lines),
        fc.shuffledSubarray(lines, { minLength: lines.length }),
        fc.subarray(lines),
      )),
      ([lines, shuffled, repeated]) => {
        // An export is ordered by the store, not by the turn, and two overlapping exports
        // concatenated repeat their shared lines; neither may move a number.
        expect(summarizeMemoryUsage([...shuffled, ...repeated]).usage)
          .toEqual(summarizeMemoryUsage(lines).usage);
      },
    ));
  });

  it("adds up to what the stream was built to contain, whatever noise surrounds it", () => {
    fc.assert(fc.property(memoryLogScenario, ({ expected, lines }) => {
      const { usage } = summarizeMemoryUsage(lines);
      const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

      // The truth comes from the shapes the generator assembled, not from the lines: resumed
      // selections, pre-release lines, failed selections and untracked runs must all fall away.
      expect({
        finalAnswers: usage.finalAnswers,
        offered: usage.offered,
        rejected: sum(Object.values(usage.rejected)),
        tracked: usage.selections.tracked,
        used: usage.used,
      }).toEqual(expected);
      expect(sum(Object.values(usage.usedByPosition))).toBe(usage.used);
      expect(sum(Object.values(usage.byBranch).map((one) => one.used))).toBe(usage.used);
    }));
  });
});
