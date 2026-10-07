/**
 * Operator entrypoint of the answer-level measurement: what memory changes in the answers.
 *
 *   answers <dir>  every planned turn under its conditions → <dir>/answers.jsonl
 *   sheet <dir>    <dir>/answers.jsonl → <dir>/judging-sheet.txt and <dir>/judging-key.jsonl
 *   score <dir>    <dir>/answers.jsonl with <dir>/judgments.jsonl and the key → JSON
 *
 * <dir> is a golden-set run directory (pools.jsonl, labels.jsonl, outside-pool.jsonl from
 * `scripts/memory-quality/golden/`). `answers` runs through compose.memory-golden-eval.yaml, service
 * `answers`, on a fresh tuned `_eval` copy restored from the same backup, with the production model
 * configuration and key. It rewinds the copy turn by turn, newest first, and asks the model once per
 * condition. A failed request stops it; run it again and it continues on the same copy from
 * answers.jsonl.partial, because every turn left is older than the one the copy stands at.
 *
 * The judge gets judging-sheet.txt alone: judging-key.jsonl and answers.jsonl say which answer is
 * which. `judgments.jsonl` holds one {"turnId", "label", "neededFacts", "strayMemory"} line per
 * answer; the verdicts are defined in answer-score.ts.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

import { AppError, isAppError } from "../../../agent/lib/app-error.js";
import { closeDatabase } from "../../../agent/lib/database.js";
import { requireMemoryAuthorization } from "../../../agent/lib/memory-context.js";
import { recordDetails, requireDisposableCopy, requireResumableCopy, rewindCopyTo } from "../golden/candidate-pool.js";
import { loadGoldenSet, parseLines, PRIVATE_FILE_MODE, requirePrivateDirectory } from "../golden/golden-files.js";
import { answerPlan, requireResumablePlan, scoreAnswers, type AnswerLine, type Judgment } from "./answer-score.js";
import { generateAnswer, type GeneratedAnswer } from "./answer-turn.js";
import { judgeContext, judgingSheet, messageText } from "./judging-sheet.js";
import { ANSWER_CONDITIONS, idealSelectionBlock, selectionBlock, type MemoryBlock } from "./memory-conditions.js";
import {
  HISTORY_TAIL_MAX_CHARACTERS,
  historyTail,
  loadHistoryBefore,
  loadStoredTurn,
  turnMessages,
  turnModeBlock,
  turnSystemPrompt,
} from "./turn-prompt.js";

const [command, directory, ...extra] = process.argv.slice(2);
if (!["answers", "score", "sheet"].includes(command ?? "") || directory === undefined || extra.length > 0) {
  throw new AppError(
    "AGENT_MEMORY_ANSWERS_USAGE",
    "Укажите команду и папку данных замера: run.ts answers|sheet|score <папка>",
  );
}

const conditionSchema = z.enum(ANSWER_CONDITIONS);
const answerLine = z.object({
  condition: conditionSchema,
  context: z.array(z.string()),
  declaredRefs: z.array(z.string()).nullable(),
  finishReason: z.string(),
  inputTokens: z.number().nullable(),
  message: z.string(),
  neededRecords: z.array(z.object({ content: z.string(), memoryRef: z.string().min(1) })),
  outcome: z.enum(["answered", "cut_off", "empty", "silent"]),
  outputTokens: z.number().nullable(),
  requests: z.number().int().nonnegative(),
  shownRefs: z.array(z.string()),
  text: z.string(),
  toolCalls: z.array(z.object({
    from: z.string().nullable(),
    query: z.string().nullable(),
    rejected: z.boolean(),
    rejectedInput: z.string().nullable(),
    resultRefs: z.array(z.string()),
    to: z.string().nullable(),
    toolName: z.string().nullable(),
  })),
  turnId: z.string().min(1),
});
const keyLine = z.object({ condition: conditionSchema, label: z.enum(["A", "B", "C"]), turnId: z.string().min(1) });
const judgmentLine = z.object({
  label: z.enum(["A", "B", "C"]),
  neededFacts: z.enum(["missing", "partial", "used", "wrong"]).nullable(),
  strayMemory: z.boolean(),
  turnId: z.string().min(1),
});

/** Salt of the judging sheet's letters: long enough that no one guesses it from the answers. */
const SHEET_SALT_BYTES = 16;

function writePrivate(path: string, text: string): void {
  if (existsSync(path)) {
    throw new AppError("AGENT_MEMORY_ANSWERS_OUTPUT_EXISTS", `${path} уже существует. Удалите его сами, если он больше не нужен`);
  }
  writeFileSync(path, text, { mode: PRIVATE_FILE_MODE });
}

/**
 * The model call's error carries the request — the real conversation — and printing it would put
 * that into the log. Only its kind and status cross this boundary.
 */
async function answerOrFail(request: Parameters<typeof generateAnswer>[0]): Promise<GeneratedAnswer> {
  try {
    return await generateAnswer(request);
  } catch (error) {
    if (isAppError(error)) throw error;
    const failure = error as { message?: unknown; name?: unknown; statusCode?: unknown };
    throw new AppError(
      "AGENT_MEMORY_ANSWERS_MODEL_CALL_FAILED",
      "Запрос к модели не удался. Запустите прогон снова: он продолжится с этого хода",
      { details: {
        message: String(failure.message ?? "").slice(0, 200),
        name: String(failure.name ?? "UnknownError"),
        statusCode: typeof failure.statusCode === "number" ? failure.statusCode : "none",
      } },
    );
  }
}

async function answers(): Promise<void> {
  requirePrivateDirectory(directory!);
  if (!process.env.MODEL_API_KEY) {
    throw new AppError("AGENT_MEMORY_ANSWERS_MODEL_KEY_MISSING", "Не задан MODEL_API_KEY: ответы получают у модели продукта по её ключу");
  }
  const answersPath = join(directory!, "answers.jsonl");
  const partialPath = `${answersPath}.partial`;
  if (existsSync(answersPath)) {
    throw new AppError("AGENT_MEMORY_ANSWERS_OUTPUT_EXISTS", `В ${directory} уже есть answers.jsonl. Новый прогон пишите в новую папку`);
  }
  const { labels, outside, turns } = loadGoldenSet(directory!);
  const plan = answerPlan(turns, labels, outside);
  const done = new Set<string>();
  if (existsSync(partialPath)) {
    for (const line of parseLines(partialPath, answerLine)) done.add(`${line.turnId}:${line.condition}`);
    requireResumablePlan(plan, done);
    await requireResumableCopy();
  } else {
    await requireDisposableCopy(readdirSync(resolve("migrations")).filter((name) => name.endsWith(".sql")).sort());
    writeFileSync(partialPath, "", { mode: PRIVATE_FILE_MODE });
  }
  const total = plan.reduce((count, turn) => count + turn.conditions.length, 0);
  for (const planned of plan) {
    if (planned.conditions.every((condition) => done.has(`${planned.turnId}:${condition}`))) continue;
    await rewindCopyTo(planned.startedAt);
    const turn = await loadStoredTurn(planned.turnId);
    const history = historyTail(await loadHistoryBefore(turn), HISTORY_TAIL_MAX_CHARACTERS);
    const messages = turnMessages(turn, history);
    const modeBlock = await turnModeBlock(turn, messages);
    const authorization = requireMemoryAuthorization({ session: { auth: turn.auth } } as Parameters<typeof requireMemoryAuthorization>[0]);
    const details = await recordDetails(planned.neededRefs);
    const neededRecords = planned.neededRefs.map((memoryRef) => {
      const record = details.get(memoryRef);
      if (record === undefined) {
        throw new AppError(
          "AGENT_MEMORY_ANSWERS_NEEDED_RECORD_MISSING",
          `Нужной по разметке записи ${memoryRef} нет в копии. Восстановите ту же резервную копию, по которой собран эталон`,
        );
      }
      return { content: record.content, memoryRef };
    });
    for (const condition of planned.conditions) {
      if (done.has(`${planned.turnId}:${condition}`)) continue;
      const memory: MemoryBlock | null = condition === "no_selection"
        ? null
        : condition === "selection"
          ? await selectionBlock(authorization, planned.query)
          : await idealSelectionBlock(authorization, planned.neededRefs);
      const answer = await answerOrFail({
        auth: turn.auth,
        messages,
        sessionId: turn.sessionId,
        system: turnSystemPrompt(modeBlock, memory?.block ?? null),
        turnId: turn.turnId,
      });
      const line: AnswerLine = {
        ...answer,
        condition,
        context: judgeContext(history),
        message: messageText(turn.input.message),
        neededRecords,
        shownRefs: memory?.shownRefs ?? [],
        turnId: planned.turnId,
      };
      appendFileSync(partialPath, `${JSON.stringify(line)}\n`);
      done.add(`${planned.turnId}:${condition}`);
      // Progress without content: the log may be read where the answers may not.
      console.log(JSON.stringify({
        condition, done: done.size, inputTokens: answer.inputTokens, outcome: answer.outcome,
        requests: answer.requests, toolCalls: answer.toolCalls.length, total, turnId: planned.turnId,
      }));
    }
  }
  renameSync(partialPath, answersPath);
}

function sheet(): void {
  requirePrivateDirectory(directory!);
  const lines = parseLines(join(directory!, "answers.jsonl"), answerLine);
  const questionByTurn = new Map(loadGoldenSet(directory!).turns.map((turn) => [turn.turnId, turn.message]));
  const { key, sheet: text } = judgingSheet(lines, questionByTurn, randomBytes(SHEET_SALT_BYTES).toString("hex"));
  writePrivate(join(directory!, "judging-sheet.txt"), text);
  writePrivate(join(directory!, "judging-key.jsonl"), key.map((one) => `${JSON.stringify(one)}\n`).join(""));
}

function score(): void {
  const lines = parseLines(join(directory!, "answers.jsonl"), answerLine);
  const judgments: Judgment[] = parseLines(join(directory!, "judgments.jsonl"), judgmentLine);
  const key = parseLines(join(directory!, "judging-key.jsonl"), keyLine);
  console.log(JSON.stringify(scoreAnswers(lines, judgments, key), null, 2));
}

try {
  if (command === "answers") await answers();
  else if (command === "sheet") sheet();
  else score();
} finally {
  await closeDatabase();
}
