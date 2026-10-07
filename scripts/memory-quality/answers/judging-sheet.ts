/**
 * What the judge reads: each turn with its needed records and its answers, conditions hidden.
 *
 * Exports:
 * - `JUDGE_CONTEXT_MESSAGES` / `judgeContext`: the last messages before the question, shortened.
 * - `messageText`: the text of a message, whatever parts it came in.
 * - `judgingSheet`: the sheet and the key that maps its letters back to conditions.
 */
import type { ModelMessage } from "ai";

import { AppError } from "../../../agent/lib/app-error.js";
import { blindLabels, type AnswerLine, type JudgingKeyLine } from "./answer-score.js";
import type { AnswerOutcome } from "./answer-turn.js";

/** Enough to see what was being discussed; the rest of the history is the model's, not the judge's. */
export const JUDGE_CONTEXT_MESSAGES = 4;
const JUDGE_LINE_CHARACTERS = 400;
/** A group turn's message is the whole recent timeline; its end is the part the reply answers. */
const JUDGE_MESSAGE_TAIL_CHARACTERS = 1_500;

/** What the judge reads in place of an answer that has no text. */
const NO_TEXT: Record<Exclude<AnswerOutcome, "answered">, string> = {
  cut_off: "(ответа нет: лимит шагов кончился на вызовах инструментов)",
  empty: "(модель вернула пустой ответ)",
  silent: "(модель намеренно промолчала)",
};

export function messageText(content: ModelMessage["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : `[${part.type}]`)).join(" ");
}

export function judgeContext(history: readonly ModelMessage[]): string[] {
  return history
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-JUDGE_CONTEXT_MESSAGES)
    .map((message) => `${message.role}: ${messageText(message.content).replace(/\s+/gu, " ").slice(0, JUDGE_LINE_CHARACTERS)}`);
}

export function judgingSheet(
  answers: readonly AnswerLine[],
  /** The addressed question as the golden set holds it, without the timeline around it. */
  questionByTurn: ReadonlyMap<string, string>,
  /** Drawn fresh for each sheet and never written down: the key is the only way back. */
  salt: string,
): { key: JudgingKeyLine[]; sheet: string } {
  const byTurn = new Map<string, AnswerLine[]>();
  for (const answer of answers) byTurn.set(answer.turnId, [...byTurn.get(answer.turnId) ?? [], answer]);
  const key: JudgingKeyLine[] = [];
  const blocks = [...byTurn.keys()].sort().map((turnId) => {
    const turnAnswers = byTurn.get(turnId)!;
    const first = turnAnswers[0]!;
    const question = questionByTurn.get(turnId);
    if (question === undefined) {
      throw new AppError(
        "AGENT_MEMORY_ANSWERS_QUESTION_MISSING",
        `Хода ${turnId} из answers.jsonl нет в pools.jsonl этой папки. Лист собирается из папки того же прогона`,
      );
    }
    const labels = blindLabels(turnId, turnAnswers.map((answer) => answer.condition), salt);
    const lettered = turnAnswers
      .map((answer) => ({ answer, label: labels.get(answer.condition)! }))
      .sort((left, right) => left.label.localeCompare(right.label));
    key.push(...lettered.map(({ answer, label }) => ({ condition: answer.condition, label, turnId })));
    const needed = first.neededRecords.length === 0
      ? ["НУЖНО: ничего из памяти"]
      : first.neededRecords.map((record) => `НУЖНО: ${record.content}`);
    return [
      `=== ${turnId}`,
      ...first.context.map((line) => `   | ${line}`),
      ...(question === first.message ? [] : [
        `   | сообщение хода, конец: ${first.message.slice(-JUDGE_MESSAGE_TAIL_CHARACTERS).replace(/\s+/gu, " ")}`,
      ]),
      `ВОПРОС: ${question}`,
      ...needed,
      ...lettered.map(({ answer, label }) => `--- ${label}\n${answer.outcome === "answered" ? answer.text.trim() : NO_TEXT[answer.outcome]}`),
    ].join("\n");
  });
  return { key, sheet: `${blocks.join("\n\n")}\n` };
}
