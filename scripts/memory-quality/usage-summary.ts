/**
 * How much of what memory offered the answers rested on, per turn, from exported log lines.
 *
 * Exports:
 * - `summarizeMemoryUsage`: folds a period's selection, search and usage lines into one summary.
 * - `MemoryUsageSummary`: what the summary says, apart from what it says about its own input.
 *
 * Why per turn and not per line: the usage line is written on every message of a turn, the
 * progress note before a tool call included. Counted line by line, a turn's selection enters the
 * denominator once per message and a record named twice is used twice; on 20.09–06.10 that read
 * 3.6% where the per-turn truth was 3.1%.
 *
 * Why offline and not on the hub: tracing a named ref the turn never showed needs three lines of
 * one turn — the profile in the selection line, the explicit search results, the earlier turns of
 * the session — and the log store has no join. The hub keeps the daily totals; this keeps the why.
 *
 * Every field arrives as text, the way the log store exports it, or as the value itself, the way
 * the application wrote it. A line that is neither is an error with its number: a report that
 * skipped what it could not read would describe a period it never saw.
 */
import { z } from "zod";

import { AppError } from "../../agent/lib/app-error.js";

type BranchClass = "semantic_only" | "unknown" | "words_and_semantic" | "words_only";

export interface MemoryUsageSummary {
  input: {
    duplicates: number;
    /** Lines written before the release that added the fields this report reads. */
    legacy: number;
    lines: number;
    /** Usage lines of a turn whose selection line is not in the export. */
    usageWithoutSelection: number;
  };
  usage: {
    /** Turns with records offered whose answer declared its usage line at least once. */
    answeredTurns: number;
    byBranch: Record<BranchClass, { offered: number; used: number }>;
    characters: { offered: number; perUsed: number | null };
    finalAnswers: { declared: number; total: number };
    /** Mean of 1 / place of the first used record over answered turns, 0 for a turn using none. */
    meanReciprocalRank: number | null;
    offered: number;
    period: { from: string; to: string } | null;
    rejected: { inProfile: number; inSearch: number; shownEarlier: number; unknown: number };
    /** Searches by query and by period, from lines of the current format only. */
    searches: { calls: number; records: number };
    selections: { empty: number; tracked: number };
    turnsWithUse: number;
    used: number;
    usedByPosition: Record<string, number>;
    /** Used records the selection did not offer: the journal also holds what the profile showed. */
    usedOutsideSelection: number;
  };
}

function jsonText<T extends z.ZodType>(schema: T) {
  return z.union([
    z.string().transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue("не JSON");
        return z.NEVER;
      }
    }).pipe(schema),
    schema,
  ]);
}

const flag = z.union([z.boolean(), z.enum(["true", "false"]).transform((text) => text === "true")]);
const count = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u).transform(Number)]);
const refs = jsonText(z.array(z.string().min(1)));

const evidenceEntry = z.object({
  memoryRef: z.string().min(1),
  position: z.number().int().positive(),
  ranking: z.object({
    branches: z.array(z.enum(["russian", "semantic", "simple"])).min(1),
  }).nullable(),
});

const lineHead = { _time: z.string().min(1), sessionId: z.string().min(1), turnId: z.string().min(1) };

const exportedLine = z.discriminatedUnion("code", [
  z.object({
    ...lineHead,
    code: z.literal("AGENT_MEMORY_RETRIEVAL_METRICS"),
    memoryEvidence: jsonText(z.array(evidenceEntry)).optional(),
    memorySerializedCharacters: count.optional(),
    outcome: z.string().min(1),
    profileMemoryRefs: refs.optional(),
    usageTracked: flag.optional(),
  }),
  z.object({
    ...lineHead,
    code: z.literal("AGENT_MEMORY_SEARCH_METRICS"),
    memoryEvidence: jsonText(z.array(evidenceEntry)).optional(),
    memoryRefs: refs.optional(),
    outcome: z.string().min(1),
    // The store flattens the period object into two fields; one is absent for an open end.
    "window.from": z.string().optional(),
    "window.to": z.string().optional(),
  }),
  z.object({
    ...lineHead,
    code: z.literal("AGENT_MEMORY_USAGE_DIRECTIVE"),
    declared: flag,
    finishReason: z.string().min(1).optional(),
    rejectedRefs: refs.optional(),
    usedRefs: refs.optional(),
  }),
]);

type ExportedLine = z.infer<typeof exportedLine>;

interface Offered { branch: BranchClass; position: number }

interface Selection {
  characters: number;
  offered: Map<string, Offered>;
  profileRefs: Set<string>;
  time: number;
  /** Ties at the same millisecond are broken by the line itself, so input order never decides. */
  tieBreak: string;
}

interface Turn {
  declared: boolean;
  finalAnswers: boolean[];
  /** Each rejected ref with the earliest moment the turn named it. */
  rejectedRefs: Map<string, number>;
  searchRefs: Set<string>;
  selection: Selection | null;
  sessionId: string;
  usageLines: number;
  usedRefs: Set<string>;
}

/** A moment a ref was put in front of the model: in a block, a profile view or a search result. */
interface Sighting { time: number; turnKey: string }

/** Keys sorted, so the same line exported twice is recognised whatever order its fields came in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function branchOf(entry: z.infer<typeof evidenceEntry>): BranchClass {
  if (entry.ranking === null) return "unknown";
  const words = entry.ranking.branches.some((branch) => branch !== "semantic");
  const semantic = entry.ranking.branches.includes("semantic");
  if (words && semantic) return "words_and_semantic";
  return words ? "words_only" : "semantic_only";
}

function parseLine(raw: unknown, index: number): ExportedLine {
  const parsed = exportedLine.safeParse(raw);
  if (parsed.success && Number.isFinite(Date.parse(parsed.data._time))) return parsed.data;
  throw new AppError(
    "AGENT_MEMORY_USAGE_REPORT_LINE_INVALID",
    `Не удалось прочитать строку ${index + 1} выгрузки логов памяти. Проверьте, что выгружены только строки AGENT_MEMORY_RETRIEVAL_METRICS, AGENT_MEMORY_SEARCH_METRICS и AGENT_MEMORY_USAGE_DIRECTIVE`,
    { cause: parsed.success ? new Error(`unparseable _time: ${parsed.data._time}`) : parsed.error },
  );
}

/** Whether the line carries the fields of the release this report was written for. */
function isCurrent(line: ExportedLine): boolean {
  if (line.code === "AGENT_MEMORY_RETRIEVAL_METRICS") {
    // A failed or skipped selection never gets as far as the window, so only a successful one
    // without the flag is old; the others simply have nothing to report.
    return line.outcome !== "succeeded" || line.usageTracked !== undefined;
  }
  if (line.code === "AGENT_MEMORY_USAGE_DIRECTIVE") return line.finishReason !== undefined;
  // A search by query now always carries its evidence; a search by period never had any and
  // reads the same before and after the release, so its window is what marks it as readable.
  return line.memoryEvidence !== undefined || line["window.from"] !== undefined ||
    line["window.to"] !== undefined || line.outcome !== "succeeded";
}

/**
 * The fields a current line always carries. A missing one means the export left it out of its
 * field list, and reading on would report zeros the period never had.
 */
function requiredFieldMissing(line: ExportedLine): string | null {
  if (line.code === "AGENT_MEMORY_RETRIEVAL_METRICS") {
    if (line.outcome !== "succeeded") return null;
    if (line.memoryEvidence === undefined) return "memoryEvidence";
    if (line.memorySerializedCharacters === undefined) return "memorySerializedCharacters";
    return line.profileMemoryRefs === undefined ? "profileMemoryRefs" : null;
  }
  if (line.code === "AGENT_MEMORY_USAGE_DIRECTIVE") {
    if (line.usedRefs === undefined) return "usedRefs";
    return line.rejectedRefs === undefined ? "rejectedRefs" : null;
  }
  return line.outcome === "succeeded" && line.memoryRefs === undefined ? "memoryRefs" : null;
}

function requireFields(line: ExportedLine, index: number): void {
  const missing = requiredFieldMissing(line);
  if (missing === null) return;
  throw new AppError(
    "AGENT_MEMORY_USAGE_REPORT_LINE_INVALID",
    `В строке ${index + 1} выгрузки логов памяти нет поля ${missing}. Выгрузите логи заново со списком полей из шапки scripts/memory-quality/usage-report.ts`,
  );
}

function emptyBranches(): MemoryUsageSummary["usage"]["byBranch"] {
  const zero = () => ({ offered: 0, used: 0 });
  return { semantic_only: zero(), unknown: zero(), words_and_semantic: zero(), words_only: zero() };
}

export function summarizeMemoryUsage(rawLines: readonly unknown[]): MemoryUsageSummary {
  const input = { duplicates: 0, legacy: 0, lines: rawLines.length, usageWithoutSelection: 0 };
  const seen = new Set<string>();
  const turns = new Map<string, Turn>();
  const searches = { calls: 0, records: 0 };
  const sightings = new Map<string, Map<string, Sighting[]>>();
  let from: number | null = null;
  let to: number | null = null;

  rawLines.forEach((raw, index) => {
    const line = parseLine(raw, index);
    const key = canonical(raw);
    if (seen.has(key)) {
      input.duplicates += 1;
      return;
    }
    seen.add(key);
    if (!isCurrent(line)) {
      input.legacy += 1;
      return;
    }
    requireFields(line, index);
    const time = Date.parse(line._time);
    from = from === null ? time : Math.min(from, time);
    to = to === null ? time : Math.max(to, time);
    const turnKey = `${line.sessionId}\u0000${line.turnId}`;
    const turn: Turn = turns.get(turnKey) ?? {
      declared: false, finalAnswers: [], rejectedRefs: new Map(), searchRefs: new Set(),
      selection: null, sessionId: line.sessionId, usageLines: 0, usedRefs: new Set(),
    };
    turns.set(turnKey, turn);
    const sighted = (memoryRefs: readonly string[]) => {
      const session = sightings.get(line.sessionId) ?? new Map<string, Sighting[]>();
      sightings.set(line.sessionId, session);
      for (const memoryRef of memoryRefs) {
        const seenAt = session.get(memoryRef);
        if (seenAt === undefined) session.set(memoryRef, [{ time, turnKey }]);
        else seenAt.push({ time, turnKey });
      }
    };

    if (line.code === "AGENT_MEMORY_SEARCH_METRICS") {
      if (line.outcome !== "succeeded") return;
      const found = line.memoryRefs!;
      searches.calls += 1;
      searches.records += found.length;
      for (const memoryRef of found) turn.searchRefs.add(memoryRef);
      sighted(found);
      return;
    }
    if (line.code === "AGENT_MEMORY_USAGE_DIRECTIVE") {
      turn.usageLines += 1;
      turn.declared ||= line.declared;
      if (line.finishReason === "stop") turn.finalAnswers.push(line.declared);
      for (const memoryRef of line.usedRefs!) turn.usedRefs.add(memoryRef);
      for (const memoryRef of line.rejectedRefs!) {
        turn.rejectedRefs.set(memoryRef, Math.min(turn.rejectedRefs.get(memoryRef) ?? time, time));
      }
      return;
    }
    if (line.outcome !== "succeeded") return;
    const evidence = line.memoryEvidence!;
    sighted([
      ...evidence.map((entry) => entry.memoryRef),
      ...line.profileMemoryRefs!,
    ]);
    if (line.usageTracked !== true) return;
    // A resumed turn resolves its block again; the model answered from the latest one.
    const tieBreak = key;
    const current = turn.selection;
    if (current !== null && (current.time > time || (current.time === time && current.tieBreak > tieBreak))) return;
    const offered = new Map<string, Offered>();
    for (const entry of evidence) {
      offered.set(entry.memoryRef, { branch: branchOf(entry), position: entry.position });
    }
    turn.selection = {
      characters: line.memorySerializedCharacters!,
      offered,
      profileRefs: new Set(line.profileMemoryRefs!),
      tieBreak,
      time,
    };
  });

  const usage: MemoryUsageSummary["usage"] = {
    answeredTurns: 0,
    byBranch: emptyBranches(),
    characters: { offered: 0, perUsed: null },
    finalAnswers: { declared: 0, total: 0 },
    meanReciprocalRank: null,
    offered: 0,
    period: from === null || to === null ? null : {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    },
    rejected: { inProfile: 0, inSearch: 0, shownEarlier: 0, unknown: 0 },
    searches,
    selections: { empty: 0, tracked: 0 },
    turnsWithUse: 0,
    used: 0,
    usedByPosition: {},
    usedOutsideSelection: 0,
  };
  let reciprocalRanks = 0;
  // A fixed order, not arrival order: floating-point sums depend on the order they are added in,
  // and the same export read in another order must give the same numbers to the last digit.
  const tracked = [...turns.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([, turn]) => turn.selection !== null);
  for (const turn of turns.values()) {
    if (turn.selection === null) input.usageWithoutSelection += turn.usageLines;
  }

  for (const [turnKey, turn] of tracked) {
    const selection = turn.selection!;
    usage.selections.tracked += 1;
    usage.characters.offered += selection.characters;
    usage.finalAnswers.total += turn.finalAnswers.length === 0 ? 0 : 1;
    usage.finalAnswers.declared += turn.finalAnswers.some(Boolean) ? 1 : 0;
    if (selection.offered.size === 0) usage.selections.empty += 1;
    for (const offered of selection.offered.values()) {
      usage.offered += 1;
      usage.byBranch[offered.branch].offered += 1;
    }

    const usedPositions: number[] = [];
    for (const memoryRef of turn.usedRefs) {
      const offered = selection.offered.get(memoryRef);
      if (offered === undefined) {
        usage.usedOutsideSelection += 1;
        continue;
      }
      usage.used += 1;
      usage.byBranch[offered.branch].used += 1;
      usage.usedByPosition[offered.position] = (usage.usedByPosition[offered.position] ?? 0) + 1;
      usedPositions.push(offered.position);
    }
    if (selection.offered.size > 0 && turn.declared) {
      usage.answeredTurns += 1;
      if (usedPositions.length > 0) {
        usage.turnsWithUse += 1;
        reciprocalRanks += 1 / Math.min(...usedPositions);
      }
    }

    // First match wins, in the order the model met them: this turn's profile view, then its own
    // searches, then anything an earlier turn of the session showed it — its block, its profile
    // or its search results, all of which stay in the conversation history.
    const session = sightings.get(turn.sessionId);
    for (const [memoryRef, namedAt] of turn.rejectedRefs) {
      if (selection.profileRefs.has(memoryRef)) usage.rejected.inProfile += 1;
      else if (turn.searchRefs.has(memoryRef)) usage.rejected.inSearch += 1;
      else if ((session?.get(memoryRef) ?? []).some((one) => one.turnKey !== turnKey && one.time < namedAt)) {
        usage.rejected.shownEarlier += 1;
      } else usage.rejected.unknown += 1;
    }
  }

  usage.characters.perUsed = usage.used === 0 ? null : usage.characters.offered / usage.used;
  usage.meanReciprocalRank = usage.answeredTurns === 0 ? null : reciprocalRanks / usage.answeredTurns;
  return { input, usage };
}
