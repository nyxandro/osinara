/**
 * Answer-level measurement tests: the plan, the blinding, the resume guard, and the score.
 *
 * Constructs covered:
 * - Every turn that needed memory is answered under all three conditions with its needed records
 *   from the pool and from outside it; every third turn that needed nothing, under the two
 *   conditions that differ for it; the copy is walked newest first. A half-labelled turn stops it.
 * - The judge's letters are a salted shuffle of the conditions: the same salt gives the same
 *   letters, and the sheet names no condition and says why an answer has no text.
 * - A run resumes only on its own plan, from where it stopped.
 * - Verdicts join back through the key; a missing, doubled or misplaced verdict stops the score;
 *   an unreported token count makes the cost unknown rather than zero; a turn no condition
 *   answered is set apart, since no memory could have changed it.
 * - A history tail starts at a person's message and stays within its budget.
 */
import { describe, expect, it } from "vitest";

import { goldenTurn } from "../golden/golden-turns.test-fixtures.js";
import type { GoldenSetTurn } from "../golden/golden-files.js";
import {
  answerPlan,
  blindLabels,
  requireResumablePlan,
  scoreAnswers,
  type AnswerLine,
  type Judgment,
  type JudgingKeyLine,
} from "./answer-score.js";
import { judgingSheet } from "./judging-sheet.js";
import { ANSWER_CONDITIONS, type AnswerCondition } from "./memory-conditions.js";
import { historyTail } from "./turn-prompt.js";

const SALT = "test-salt";

function setTurn(turnId: string, startedAt: string, pool: string[]): GoldenSetTurn {
  const turn = goldenTurn({ offered: [], pool, turnId });
  return { ...turn, pool: turn.pool.map((record) => ({ ...record, content: `текст ${record.memoryRef}` })), startedAt };
}

function answer(turnId: string, condition: AnswerCondition, needed: string[], overrides: Partial<AnswerLine> = {}): AnswerLine {
  return {
    condition, context: [], declaredRefs: null, finishReason: "stop", inputTokens: 1000, message: `вопрос ${turnId}`,
    neededRecords: needed.map((memoryRef) => ({ content: `текст ${memoryRef}`, memoryRef })), outcome: "answered",
    outputTokens: 50, requests: 1, shownRefs: [], text: "ответ модели", toolCalls: [], turnId, ...overrides,
  };
}

function keyFor(lines: readonly AnswerLine[]): JudgingKeyLine[] {
  const byTurn = new Map<string, AnswerCondition[]>();
  for (const line of lines) byTurn.set(line.turnId, [...byTurn.get(line.turnId) ?? [], line.condition]);
  return [...byTurn].flatMap(([turnId, conditions]) =>
    [...blindLabels(turnId, conditions, SALT)].map(([condition, label]) => ({ condition, label, turnId })));
}

const labelOf = (lines: readonly AnswerLine[], turnId: string, condition: AnswerCondition) =>
  keyFor(lines).find((line) => line.turnId === turnId && line.condition === condition)!.label;

describe("answerPlan", () => {
  const turns = [
    setTurn("t-need", "2026-10-04T10:00:00.000Z", ["a", "b"]),
    setTurn("t-outside", "2026-10-05T10:00:00.000Z", ["c"]),
    ...["n0", "n1", "n2", "n3"].map((id, index) => setTurn(id, `2026-10-0${index + 1}T09:00:00.000Z`, ["x"])),
  ];
  const labels = turns.map((turn) => ({
    relevant: new Map(turn.pool.map((record) => [record.memoryRef, turn.turnId === "t-need" && record.memoryRef === "b"])),
    turnId: turn.turnId,
  }));

  it("answers needed turns under every condition and samples the rest, newest first", () => {
    const plan = answerPlan(turns, labels, new Map([["t-outside", new Set(["far"])]]));

    expect(plan.map((turn) => [turn.turnId, turn.conditions, turn.neededRefs])).toEqual([
      ["t-outside", ANSWER_CONDITIONS, ["far"]],
      ["t-need", ANSWER_CONDITIONS, ["b"]],
      ["n3", ["no_selection", "selection"], []],
      ["n0", ["no_selection", "selection"], []],
    ]);
  });

  it("stops at a turn left half-labelled instead of treating it as one that needed nothing", () => {
    const halfLabelled = labels.map((one) => one.turnId === "t-need" ? { ...one, relevant: new Map([["a", false]]) } : one);

    expect(() => answerPlan(turns, halfLabelled, new Map())).toThrow(/AGENT_MEMORY_GOLDEN_LABEL_MISSING/u);
  });
});

describe("requireResumablePlan", () => {
  const plan = [
    { conditions: ANSWER_CONDITIONS, neededRefs: ["a"], query: "q", startedAt: "2026-10-05T00:00:00.000Z", turnId: "newer" },
    { conditions: ANSWER_CONDITIONS, neededRefs: ["b"], query: "q", startedAt: "2026-10-04T00:00:00.000Z", turnId: "older" },
  ];

  it("continues a run that stopped part-way through a turn", () => {
    expect(() => requireResumablePlan(plan, new Set(["newer:no_selection", "newer:selection", "newer:ideal_selection", "older:no_selection"])))
      .not.toThrow();
  });

  it("refuses answers from another plan or out of order", () => {
    expect(() => requireResumablePlan(plan, new Set(["elsewhere:selection"]))).toThrow(/AGENT_MEMORY_ANSWERS_RESUME_MISMATCH/u);
    expect(() => requireResumablePlan(plan, new Set(["newer:no_selection", "older:no_selection"])))
      .toThrow(/AGENT_MEMORY_ANSWERS_RESUME_MISMATCH/u);
  });
});

describe("blind judging", () => {
  it("letters each turn's answers by a salted shuffle that does not follow the conditions", () => {
    const orders = new Set(Array.from({ length: 20 }, (_, index) =>
      ANSWER_CONDITIONS.map((condition) => blindLabels(`turn-${index}`, ANSWER_CONDITIONS, SALT).get(condition)).join("")));

    expect(blindLabels("turn-1", ANSWER_CONDITIONS, SALT)).toEqual(blindLabels("turn-1", ANSWER_CONDITIONS, SALT));
    for (const order of orders) expect([...order].sort().join("")).toBe("ABC");
    expect(orders.size).toBeGreaterThan(1);
  });

  it("shows the judge answers and needed records but never a condition", () => {
    const lines = ANSWER_CONDITIONS.map((condition) => answer("t1", condition, ["a"], condition === "selection"
      ? { outcome: "silent", text: "" } : {}));
    const { key, sheet } = judgingSheet(lines, new Map([["t1", "какой код домофона?"]]), SALT);

    for (const condition of ANSWER_CONDITIONS) expect(sheet).not.toContain(condition);
    expect(sheet).toContain("НУЖНО: текст a");
    expect(sheet).toContain("ВОПРОС: какой код домофона?");
    expect(sheet).toContain("(модель намеренно промолчала)");
    expect(key).toEqual(keyFor(lines).sort((left, right) => left.label.localeCompare(right.label)));
  });

  it("refuses a sheet for answers whose question the pools do not hold", () => {
    expect(() => judgingSheet([answer("t1", "selection", [])], new Map(), SALT)).toThrow(/AGENT_MEMORY_ANSWERS_QUESTION_MISSING/u);
  });
});

describe("scoreAnswers", () => {
  it("joins verdicts back to conditions and counts them", () => {
    const lines = [
      ...ANSWER_CONDITIONS.map((condition) => answer("need", condition, ["a"], condition === "no_selection"
        ? { toolCalls: [
          { from: "2026-10-01", query: "что было", rejected: false, rejectedInput: null, resultRefs: ["a"], to: "2026-10-02", toolName: "search_memories" },
          { from: null, query: null, rejected: true, rejectedInput: "{\"url\":\"https://example.com\"}", resultRefs: [], to: null, toolName: "web_fetch" },
        ] } : {})),
      answer("quiet", "no_selection", []),
      answer("quiet", "selection", [], { inputTokens: null }),
    ];
    const verdict: Record<AnswerCondition, Judgment["neededFacts"]> = { ideal_selection: "used", no_selection: "partial", selection: "wrong" };
    const judgments: Judgment[] = [
      ...ANSWER_CONDITIONS.map((condition) => ({
        label: labelOf(lines, "need", condition), neededFacts: verdict[condition], strayMemory: condition === "selection", turnId: "need",
      })),
      { label: labelOf(lines, "quiet", "no_selection"), neededFacts: null, strayMemory: false, turnId: "quiet" },
      { label: labelOf(lines, "quiet", "selection"), neededFacts: null, strayMemory: true, turnId: "quiet" },
    ];

    const score = scoreAnswers(lines, judgments, keyFor(lines));

    expect(score.no_selection).toMatchObject({
      callsWithoutResult: 1, meanInputTokens: 1000, needed: { missing: 0, partial: 1, turns: 1, used: 0, wrong: 0 },
      periodSearchRate: 1 / 2, searchedRate: 1 / 2, strayWhenNotNeeded: 0,
    });
    expect(score.selection).toMatchObject({
      meanInputTokens: null, needed: { wrong: 1 }, strayWhenNeeded: 1, strayWhenNotNeeded: 1,
    });
    expect(score.ideal_selection).toMatchObject({ needed: { used: 1 }, strayWhenNotNeeded: null });
  });

  it("sets apart a turn no condition answered", () => {
    const lines = [
      ...ANSWER_CONDITIONS.map((condition) => answer("answered", condition, ["a"])),
      ...ANSWER_CONDITIONS.map((condition) => answer("silent", condition, ["b"], { outcome: "silent", text: "" })),
    ];
    const judgments = ["answered", "silent"].flatMap((turnId) => ANSWER_CONDITIONS.map((condition) => ({
      label: labelOf(lines, turnId, condition), neededFacts: turnId === "silent" ? "missing" as const : "used" as const,
      strayMemory: false, turnId,
    })));

    const score = scoreAnswers(lines, judgments, keyFor(lines));

    expect(score.selection).toMatchObject({
      needed: { missing: 1, turns: 2, used: 1 }, neededWhereAnswered: { missing: 0, turns: 1, used: 1 }, unanswered: 1,
    });
  });

  it("stops at a missing, doubled or misplaced verdict", () => {
    const lines = [answer("q", "no_selection", []), answer("q", "selection", [])];
    const ok = (["no_selection", "selection"] as const).map((condition) => ({
      label: labelOf(lines, "q", condition), neededFacts: null, strayMemory: false, turnId: "q",
    }));

    expect(() => scoreAnswers(lines, ok.slice(0, 1), keyFor(lines))).toThrow(/AGENT_MEMORY_ANSWERS_JUDGMENTS_INVALID/u);
    expect(() => scoreAnswers(lines, [ok[0]!, ok[0]!], keyFor(lines))).toThrow(/AGENT_MEMORY_ANSWERS_JUDGMENTS_INVALID/u);
    expect(() => scoreAnswers(lines, [ok[0]!, { ...ok[1]!, neededFacts: "used" }], keyFor(lines)))
      .toThrow(/AGENT_MEMORY_ANSWERS_JUDGMENTS_INVALID/u);
  });
});

describe("historyTail", () => {
  it("starts at a person's message and keeps within the budget", () => {
    const messages = [
      { content: "первый вопрос", role: "user" as const },
      { content: "длинный ответ ".repeat(20), role: "assistant" as const },
      { content: "второй вопрос", role: "user" as const },
      { content: [{ input: {}, toolCallId: "c1", toolName: "search_memories", type: "tool-call" as const }], role: "assistant" as const },
      { content: "короткий ответ", role: "assistant" as const },
    ];
    const tailOfLastExchange = messages.slice(2).reduce((total, message) => total + JSON.stringify(message).length, 0);

    expect(historyTail(messages, tailOfLastExchange)).toEqual(messages.slice(2));
    expect(historyTail(messages, 1_000_000)).toEqual(messages);
    expect(historyTail(messages, tailOfLastExchange - 1)).toEqual([]);
  });
});
