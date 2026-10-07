/**
 * Which turns are answered under which conditions, how the answers are judged blind, and the score.
 *
 * Exports:
 * - `NO_NEED_SAMPLE_EVERY` / `PlannedTurn` / `answerPlan`: every turn that needed memory under all
 *   three conditions; every third turn that needed none under the two that differ for it.
 * - `requireResumablePlan`: refuses to continue a run whose finished answers are not this plan's.
 * - `AnswerLine`: one generated answer as `answers.jsonl` holds it.
 * - `JudgingKeyLine` / `blindLabels`: a condition-free order of one turn's answers, lettered A, B, C
 *   with a salt only the key knows.
 * - `Judgment` / `scoreAnswers`: the judge's verdicts joined back to conditions, and the numbers.
 *
 * The judge sees the question, its context, the needed records and the answers in lettered order —
 * never which condition produced which answer, nor what was searched. The order hangs on a random
 * salt drawn when the sheet is made: nothing in the repository or the answers can reproduce it, and
 * the key that can is the only way the score joins verdicts back.
 *
 * Verdicts, per answer:
 * - `neededFacts` (only for a turn that needed memory): `used` — the answer relies on the needed
 *   facts correctly; `partial` — on some of them; `missing` — on none, «не помню» and silence
 *   included; `wrong` — it states something the needed records contradict.
 * - `strayMemory`: the answer brings in remembered facts the question did not call for, or pins
 *   one on the wrong person.
 */
import { createHash } from "node:crypto";

import { AppError } from "../../../agent/lib/app-error.js";
import type { GoldenSetTurn } from "../golden/golden-files.js";
import { requireLabels, type GoldenLabels } from "../golden/golden-score.js";
import type { GeneratedAnswer } from "./answer-turn.js";
import { ANSWER_CONDITIONS, type AnswerCondition } from "./memory-conditions.js";

/** A third of the turns that needed nothing: enough to see the noise, not worth tripling the cost. */
export const NO_NEED_SAMPLE_EVERY = 3;

export interface PlannedTurn {
  conditions: readonly AnswerCondition[];
  neededRefs: string[];
  query: string;
  startedAt: string;
  turnId: string;
}

export function answerPlan(
  turns: readonly GoldenSetTurn[],
  labels: readonly GoldenLabels[],
  outside: ReadonlyMap<string, ReadonlySet<string>>,
): PlannedTurn[] {
  const relevantByTurn = new Map(labels.map((one) => [one.turnId, one.relevant]));
  const planned = turns.map((turn) => {
    // An unlabelled record is not an irrelevant one: a turn half-labelled would pass for one that
    // needed nothing and be answered under the wrong conditions.
    const relevant = requireLabels(turn, relevantByTurn.get(turn.turnId));
    const neededRefs = [
      ...turn.pool.filter((record) => relevant.get(record.memoryRef) === true).map((record) => record.memoryRef),
      ...outside.get(turn.turnId) ?? [],
    ];
    return { neededRefs, query: turn.query, startedAt: turn.startedAt, turnId: turn.turnId };
  });
  const sampledNoNeed = new Set(planned.filter((turn) => turn.neededRefs.length === 0)
    .map((turn) => turn.turnId).sort().filter((_, index) => index % NO_NEED_SAMPLE_EVERY === 0));
  return planned
    .filter((turn) => turn.neededRefs.length > 0 || sampledNoNeed.has(turn.turnId))
    // For a turn that needed nothing the ideal selection is no selection: one answer covers both.
    .map((turn): PlannedTurn => ({
      ...turn,
      conditions: turn.neededRefs.length > 0 ? ANSWER_CONDITIONS : ["no_selection", "selection"],
    }))
    // Newest first: the copy can only be rewound further back.
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.turnId.localeCompare(left.turnId));
}

/**
 * A run resumes only where it stopped: walked newest first, the finished answers are a prefix of
 * the plan, at most one turn half-done. Anything else — a changed plan, lines from another run —
 * would be answered on a copy rewound past it.
 */
export function requireResumablePlan(plan: readonly PlannedTurn[], done: ReadonlySet<string>): void {
  const planned = new Set(plan.flatMap((turn) => turn.conditions.map((condition) => `${turn.turnId}:${condition}`)));
  const stray = [...done].find((entry) => !planned.has(entry));
  let reachedUnfinished = false;
  let outOfOrder: string | undefined;
  for (const turn of plan) {
    const finished = turn.conditions.filter((condition) => done.has(`${turn.turnId}:${condition}`)).length;
    if (reachedUnfinished && finished > 0) outOfOrder ??= turn.turnId;
    if (finished < turn.conditions.length) reachedUnfinished = true;
  }
  if (stray !== undefined || outOfOrder !== undefined) {
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_RESUME_MISMATCH",
      `Незаконченный файл не продолжает этот план (${stray ?? outOfOrder}). Начните прогон заново на свежей копии в новой папке`,
    );
  }
}

export interface AnswerLine extends GeneratedAnswer {
  condition: AnswerCondition;
  /** The last messages before the question, shortened, for the judge. */
  context: string[];
  /** The person's message as they wrote it. */
  message: string;
  /** What the turn needed, with its text as the copy held it; empty for a turn that needed nothing. */
  neededRecords: { content: string; memoryRef: string }[];
  /** Records the automatic block showed; empty without a block. */
  shownRefs: string[];
  turnId: string;
}

export interface JudgingKeyLine {
  condition: AnswerCondition;
  label: string;
  turnId: string;
}

const LETTERS = ["A", "B", "C"] as const;

export function blindLabels(turnId: string, conditions: readonly AnswerCondition[], salt: string): Map<AnswerCondition, string> {
  const digest = (condition: string) => createHash("sha256").update(`${salt}:${turnId}:${condition}`).digest("hex");
  const order = [...conditions].sort((left, right) => digest(left).localeCompare(digest(right)));
  return new Map(order.map((condition, index) => [condition, LETTERS[index]!]));
}

export type NeededFactsVerdict = "missing" | "partial" | "used" | "wrong";

export interface Judgment {
  label: string;
  neededFacts: NeededFactsVerdict | null;
  strayMemory: boolean;
  turnId: string;
}

type NeededVerdicts = { missing: number; partial: number; turns: number; used: number; wrong: number };

interface ConditionScore {
  /** Calls that got no result: tools the harness does not offer, or input a schema refused. */
  callsWithoutResult: number;
  /** Answers the step limit ended during tool calls, before any text. */
  cutOff: number;
  /** Mean model input tokens per answer; null when any answer's usage went unreported. */
  meanInputTokens: number | null;
  meanRequests: number;
  needed: NeededVerdicts | null;
  /**
   * The same verdicts without the turns where no condition answered at all: there no memory could
   * have changed the answer, and counting them as misses dilutes the difference memory makes.
   */
  neededWhereAnswered: NeededVerdicts | null;
  periodSearchRate: number;
  searchedRate: number;
  /** Share of answers to turns that needed memory which brought in memory not asked for. */
  strayWhenNeeded: number | null;
  /** The same over turns that needed nothing. */
  strayWhenNotNeeded: number | null;
  /** Answers without text: a deliberate silence, a cut-off, or an empty reply. */
  unanswered: number;
}

const share = (count: number, total: number) => (total === 0 ? null : count / total);

function judgingError(message: string): AppError {
  return new AppError("AGENT_MEMORY_ANSWERS_JUDGMENTS_INVALID", `${message}. Сверьте judgments.jsonl с judging-key.jsonl`);
}

export function scoreAnswers(
  answers: readonly AnswerLine[],
  judgments: readonly Judgment[],
  key: readonly JudgingKeyLine[],
): Record<AnswerCondition, ConditionScore | null> {
  const labelOf = new Map(key.map((line) => [`${line.turnId}\u0000${line.condition}`, line.label]));
  const byLabel = new Map(judgments.map((judgment) => [`${judgment.turnId}\u0000${judgment.label}`, judgment]));
  if (byLabel.size !== judgments.length) throw judgingError("Один ответ оценён дважды");
  if (judgments.length !== answers.length || key.length !== answers.length) {
    throw judgingError(`Ответов ${answers.length}, оценок ${judgments.length}, строк ключа ${key.length}`);
  }

  const judged = answers.map((answer) => {
    const label = labelOf.get(`${answer.turnId}\u0000${answer.condition}`);
    if (label === undefined) throw judgingError(`В ключе нет ответа ${answer.turnId} / ${answer.condition}`);
    const judgment = byLabel.get(`${answer.turnId}\u0000${label}`);
    if (judgment === undefined) throw judgingError(`Нет оценки ответа ${answer.turnId} / ${label}`);
    const needed = answer.neededRecords.length > 0;
    if (needed !== (judgment.neededFacts !== null)) {
      throw judgingError(`Ответ ${answer.turnId} / ${label}: neededFacts ставится только ходам, которым нужна была память`);
    }
    return { answer, judgment };
  });
  const answeredSomewhere = new Set(answers.filter((answer) => answer.outcome === "answered").map((answer) => answer.turnId));
  const verdictCounts = (entries: readonly (typeof judged)[number][]): NeededVerdicts | null => {
    if (entries.length === 0) return null;
    const count = (verdict: NeededFactsVerdict) => entries.filter((entry) => entry.judgment.neededFacts === verdict).length;
    return { missing: count("missing"), partial: count("partial"), turns: entries.length, used: count("used"), wrong: count("wrong") };
  };

  return Object.fromEntries(ANSWER_CONDITIONS.map((condition) => {
    const entries = judged.filter((entry) => entry.answer.condition === condition);
    if (entries.length === 0) return [condition, null];
    const needed = entries.filter((entry) => entry.answer.neededRecords.length > 0);
    const notNeeded = entries.filter((entry) => entry.answer.neededRecords.length === 0);
    const tokens = entries.map((entry) => entry.answer.inputTokens);
    // A call with a result can only be `search_memories`: it is the one tool the harness runs.
    const searched = (entry: (typeof judged)[number], period: boolean) => entry.answer.toolCalls
      .some((call) => !call.rejected && (!period || call.from !== null || call.to !== null));
    return [condition, {
      callsWithoutResult: entries.reduce((total, entry) => total + entry.answer.toolCalls.filter((call) => call.rejected).length, 0),
      cutOff: entries.filter((entry) => entry.answer.outcome === "cut_off").length,
      meanInputTokens: tokens.some((value) => value === null)
        ? null
        : tokens.reduce<number>((total, value) => total + value!, 0) / tokens.length,
      meanRequests: entries.reduce((total, entry) => total + entry.answer.requests, 0) / entries.length,
      needed: verdictCounts(needed),
      neededWhereAnswered: verdictCounts(needed.filter((entry) => answeredSomewhere.has(entry.answer.turnId))),
      periodSearchRate: share(entries.filter((entry) => searched(entry, true)).length, entries.length)!,
      searchedRate: share(entries.filter((entry) => searched(entry, false)).length, entries.length)!,
      strayWhenNeeded: share(needed.filter((entry) => entry.judgment.strayMemory).length, needed.length),
      strayWhenNotNeeded: share(notNeeded.filter((entry) => entry.judgment.strayMemory).length, notNeeded.length),
      unanswered: entries.filter((entry) => entry.answer.outcome !== "answered").length,
    } satisfies ConditionScore];
  })) as Record<AnswerCondition, ConditionScore | null>;
}
