/**
 * Memory log lines as the log store exports them, for the usage report tests.
 *
 * Exports:
 * - `ref`: a well-formed opaque memory ref from a small number.
 * - `selectionLine` / `searchLine` / `usageLine`: one exported line of each kind the report reads.
 * - `recordEntry`: one item of a selection's `memoryEvidence`.
 * - `memoryLogScenario`: realistic streams of all three kinds across sessions and turns, with the
 *   numbers they must add up to, known from how the stream was built rather than from the report.
 *
 * Every value is a string because that is how the store hands fields back: numbers, booleans and
 * arrays alike arrive as text, and the report has to read them in that form.
 */
import fc from "fast-check";

type ExportedLine = Record<string, string>;
type Branch = "russian" | "semantic" | "simple";

export function ref(index: number): string {
  return `mem_${index.toString(16).padStart(32, "0")}`;
}

export function recordEntry(position: number, memoryRef: string, branches: readonly Branch[] | null) {
  return {
    memoryRef,
    position,
    ranking: branches === null ? null : {
      branches,
      fusedScore: 0.01,
      semanticSimilarity: branches.includes("semantic") ? 0.8 : null,
    },
  };
}

export function selectionLine(input: {
  characters?: number;
  evidence: readonly unknown[];
  profileRefs?: readonly string[];
  sessionId: string;
  time: string;
  turnId: string;
  usageTracked?: boolean;
}): ExportedLine {
  return {
    _time: input.time,
    code: "AGENT_MEMORY_RETRIEVAL_METRICS",
    memoryEvidence: JSON.stringify(input.evidence),
    memorySerializedCharacters: String(input.characters ?? 1_000),
    outcome: "succeeded",
    profileMemoryRefs: JSON.stringify(input.profileRefs ?? []),
    sessionId: input.sessionId,
    turnId: input.turnId,
    usageTracked: String(input.usageTracked ?? true),
  };
}

export function searchLine(input: {
  refs: readonly string[];
  sessionId: string;
  time: string;
  turnId: string;
}): ExportedLine {
  return {
    _time: input.time,
    code: "AGENT_MEMORY_SEARCH_METRICS",
    memoryEvidence: JSON.stringify(input.refs.map((memoryRef, index) => recordEntry(index + 1, memoryRef, ["semantic"]))),
    memoryRefs: JSON.stringify(input.refs),
    outcome: "succeeded",
    sessionId: input.sessionId,
    turnId: input.turnId,
  };
}

export function usageLine(input: {
  declared: boolean;
  finishReason: string;
  rejectedRefs?: readonly string[];
  sessionId: string;
  time: string;
  turnId: string;
  usedRefs?: readonly string[];
}): ExportedLine {
  const usedRefs = input.usedRefs ?? [];
  const rejectedRefs = input.rejectedRefs ?? [];
  return {
    _time: input.time,
    code: "AGENT_MEMORY_USAGE_DIRECTIVE",
    countedCount: String(usedRefs.length),
    declared: String(input.declared),
    finishReason: input.finishReason,
    namedCount: String(usedRefs.length + rejectedRefs.length),
    rejectedCount: String(rejectedRefs.length),
    rejectedRefs: JSON.stringify(rejectedRefs),
    sessionId: input.sessionId,
    turnId: input.turnId,
    usedCount: String(usedRefs.length),
    usedRefs: JSON.stringify(usedRefs),
  };
}

// A small pool, so that turns of one session share refs the way a conversation repeats itself.
const POOL = 8;
const poolIndex = fc.integer({ max: POOL - 1, min: 0 });
// Refs outside the pool belong only to lines the report must ignore, so picking one up shows.
const DISCARDED_REF = ref(100);
const branchSet = fc.constantFrom<readonly Branch[] | null>(
  ["simple"], ["russian"], ["semantic"], ["simple", "semantic"], ["russian", "semantic"],
  ["simple", "russian", "semantic"], null,
);

const turnShape = fc.record({
  branches: fc.array(branchSet, { maxLength: 4, minLength: 4 }),
  // Lines a real export carries next to the ones that count: a pre-release selection, a failed
  // one, a pre-release usage line.
  noise: fc.constantFrom("none", "legacy_selection", "failed_selection", "legacy_usage"),
  offered: fc.uniqueArray(poolIndex, { maxLength: 4 }),
  profile: fc.uniqueArray(poolIndex, { maxLength: 2 }),
  // A resumed turn resolves its block again: earlier with other records, or at the same moment.
  resumed: fc.constantFrom("none", "earlier", "same_time"),
  searches: fc.array(fc.uniqueArray(poolIndex, { maxLength: 3 }), { maxLength: 2 }),
  usages: fc.array(fc.record({
    declared: fc.boolean(),
    finishReason: fc.constantFrom("stop", "tool-calls"),
    rejected: fc.uniqueArray(poolIndex, { maxLength: 2 }),
    used: fc.uniqueArray(fc.nat({ max: 3 }), { maxLength: 3 }),
    usedFromProfile: fc.boolean(),
  }), { maxLength: 3 }),
});

type TurnShape = typeof turnShape extends fc.Arbitrary<infer T> ? T : never;

/** What a stream must add up to, counted from the shapes it was built from. */
export interface ExpectedUsage {
  finalAnswers: { declared: number; total: number };
  offered: number;
  rejected: number;
  tracked: number;
  used: number;
}

function turnLines(sessionId: string, turnId: string, startedAt: number, shape: TurnShape) {
  const at = (offset: number) => new Date(startedAt + offset).toISOString();
  const refs = shape.offered.map(ref);
  const evidence: unknown[] = refs.map((memoryRef, index) => recordEntry(index + 1, memoryRef, shape.branches[index]!));
  const profileRefs = shape.profile.map(ref);
  const selection = { evidence, profileRefs, sessionId, turnId };

  // The counter accepts only refs this turn showed — the block, or the profile view beside it —
  // and a message without the line names none.
  const usages = shape.usages.map((usage) => {
    const outsideBlock = profileRefs.filter((one) => !refs.includes(one));
    const usedRefs = !usage.declared ? [] : [...new Set([
      ...(refs.length === 0 ? [] : usage.used.map((index) => refs[index % refs.length]!)),
      ...(usage.usedFromProfile ? outsideBlock.slice(0, 1) : []),
    ])];
    const rejectedRefs = !usage.declared ? [] : usage.rejected.map(ref)
      .filter((one) => !refs.includes(one) && !usedRefs.includes(one));
    return { ...usage, rejectedRefs, usedRefs };
  });

  const lines: Record<string, string>[] = [
    selectionLine({ ...selection, characters: 500 * refs.length, time: at(0) }),
    ...shape.searches.map((found, index) => searchLine({
      refs: found.map(ref), sessionId, time: at(100 + index), turnId,
    })),
    ...usages.map((usage, index) => usageLine({
      declared: usage.declared, finishReason: usage.finishReason, rejectedRefs: usage.rejectedRefs,
      sessionId, time: at(200 + index), turnId, usedRefs: usage.usedRefs,
    })),
  ];
  if (shape.resumed === "earlier") {
    // Ahead of the later one in the stream too, so neither position nor time can be mistaken for
    // the other: only the moment decides which block the model answered from.
    lines.unshift(selectionLine({ ...selection, evidence: [recordEntry(1, DISCARDED_REF, ["semantic"])],
      time: at(-50) }));
  }
  if (shape.resumed === "same_time") {
    lines.push(selectionLine({ ...selection, characters: 500 * refs.length + 1, time: at(0) }));
  }
  if (shape.noise === "legacy_selection") {
    const legacy = selectionLine({ ...selection, evidence: [recordEntry(1, DISCARDED_REF, ["simple"])],
      time: at(10) });
    delete legacy.usageTracked;
    lines.push(legacy);
  }
  if (shape.noise === "failed_selection") {
    lines.push({ _time: at(20), code: "AGENT_MEMORY_RETRIEVAL_METRICS", outcome: "failed", sessionId, turnId });
  }
  if (shape.noise === "legacy_usage") {
    const legacy = usageLine({ declared: true, finishReason: "stop", sessionId, time: at(300), turnId,
      usedRefs: [DISCARDED_REF] });
    for (const field of ["finishReason", "usedRefs", "rejectedRefs"]) delete legacy[field];
    lines.push(legacy);
  }

  const used = new Set(usages.flatMap((usage) => usage.usedRefs).filter((one) => refs.includes(one)));
  const finals = usages.filter((usage) => usage.finishReason === "stop");
  const expected: ExpectedUsage = {
    finalAnswers: {
      declared: finals.some((usage) => usage.declared) ? 1 : 0,
      total: finals.length === 0 ? 0 : 1,
    },
    offered: refs.length,
    rejected: new Set(usages.flatMap((usage) => usage.rejectedRefs)).size,
    tracked: 1,
    used: used.size,
  };
  return { expected, lines };
}

function addExpected(total: ExpectedUsage, one: ExpectedUsage): ExpectedUsage {
  return {
    finalAnswers: {
      declared: total.finalAnswers.declared + one.finalAnswers.declared,
      total: total.finalAnswers.total + one.finalAnswers.total,
    },
    offered: total.offered + one.offered,
    rejected: total.rejected + one.rejected,
    tracked: total.tracked + one.tracked,
    used: total.used + one.used,
  };
}

const NOTHING: ExpectedUsage = { finalAnswers: { declared: 0, total: 0 }, offered: 0, rejected: 0, tracked: 0, used: 0 };

export const memoryLogScenario: fc.Arbitrary<{ expected: ExpectedUsage; lines: Record<string, string>[] }> = fc
  .array(fc.record({
    turns: fc.array(turnShape, { maxLength: 4, minLength: 1 }),
    // A scheduled run or a delegated child: a selection nothing can count as used.
    untracked: fc.uniqueArray(poolIndex, { maxLength: 3 }),
  }), { maxLength: 3, minLength: 1 })
  .map((sessions) => {
    let expected = NOTHING;
    const lines = sessions.flatMap(({ turns, untracked }, session) => {
      const sessionId = `session-${session}`;
      const startedAt = Date.UTC(2026, 9, 1) + session * 3_600_000;
      const built = turns.map((shape, turn) => turnLines(sessionId, `turn_${turn}`, startedAt + turn * 60_000, shape));
      for (const one of built) expected = addExpected(expected, one.expected);
      return [
        ...built.flatMap((one) => one.lines),
        selectionLine({ evidence: untracked.map((index, position) => recordEntry(position + 1, ref(index), ["semantic"])),
          sessionId, time: new Date(startedAt + 3_000_000).toISOString(), turnId: "turn_untracked", usageTracked: false }),
      ];
    });
    return { expected, lines };
  });
