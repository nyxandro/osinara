/**
 * The end of a private question's turn: its answer, or a plain failure text, in place of «Думаю…» (#467).
 *
 * Exports:
 * - `privateAnswerContent`: what of the model's final text can stand in one private message.
 * - `PrivateQuestionDeliveryDependencies`, `createPrivateQuestionObserver`: the turn observer of the
 *   `private-question` channel.
 *
 * Key constructs:
 * - The only Telegram call is the edit of the question's own «Думаю…»: no typing, no progress notice, no
 *   reaction, no second message. Step texts are not delivered; the turn's final text is.
 * - The answer is one message: the model's split points are joined, its answer-choice buttons, reactions and
 *   silence have no place in a private reply, and an answer over one Rich Message is not cut but refused.
 * - A replayed edit after a restart is answered "not modified" and counts as delivered; Telegram answers
 *   True even when the person never sees an edit, so `answered` means "Telegram took it".
 */
import { AppError } from "../app-error.js";
import { formatTelegramRichMessages } from "../telegram-rich-markdown.js";
import { stripTelegramAsideDirectives } from "../telegram-authored-split.js";
import { telegramOutputWithoutMemoryDirective } from "../telegram-progress.js";
import type { TurnObserver } from "../../runtime/turn/run-turn.js";
import type { TurnRecord } from "../../runtime/turn/turn-types.js";
import type { PrivateQuestionRow, PrivateQuestionStore } from "./private-question-repository.js";
import type { EphemeralContent, PrivateQuestionTelegram } from "./private-question-telegram.js";
import { PRIVATE_QUESTION_CODES, PRIVATE_QUESTION_TEXTS } from "./private-question-texts.js";

const MODEL_UNAVAILABLE_CODE = "AGENT_MODEL_TEMPORARILY_UNAVAILABLE";

export type PrivateAnswer =
  | { readonly kind: "answer"; readonly markdown: string }
  | { readonly kind: "empty" }
  | { readonly kind: "too_long" };

export function privateAnswerContent(text: string | null): PrivateAnswer {
  if (text === null) return { kind: "empty" };
  const { output } = telegramOutputWithoutMemoryDirective({ finishReason: "stop", message: text });
  if (output === null || output.kind !== "message") return { kind: "empty" };
  let chunks: string[];
  try {
    chunks = formatTelegramRichMessages(stripTelegramAsideDirectives(output.message));
  } catch (error) {
    // One block bigger than a message cannot be shown privately either; any other refusal stays a failure.
    if (error instanceof AppError && error.code === "AGENT_TELEGRAM_RICH_BLOCK_TOO_LONG") return { kind: "too_long" };
    throw error;
  }
  if (chunks.length === 0) return { kind: "empty" };
  if (chunks.length > 1) return { kind: "too_long" };
  return { kind: "answer", markdown: chunks[0]! };
}

export interface PrivateQuestionDeliveryDependencies {
  bindApplicationSession(applicationSessionId: string, agentSessionId: string): Promise<void>;
  recordSessionTurn(applicationSessionId: string, agentSessionId: string, outcome: "completed" | "failed"): Promise<void>;
  store: Pick<PrivateQuestionStore, "changeById" | "findById">;
  telegram: PrivateQuestionTelegram;
}

function attribute(turn: TurnRecord, name: string): string {
  const value = turn.auth.current?.attributes[name];
  if (typeof value !== "string" || !value) {
    throw new AppError("AGENT_PRIVATE_QUESTION_CONTEXT_INVALID", "Не удалось определить личный вопрос этого хода", {
      details: { attribute: name, turnId: turn.id },
    });
  }
  return value;
}

export function createPrivateQuestionObserver(dependencies: PrivateQuestionDeliveryDependencies): TurnObserver {
  async function show(row: PrivateQuestionRow, content: EphemeralContent) {
    if (row.placeholderEphemeralMessageId === null) {
      throw new AppError("AGENT_PRIVATE_QUESTION_PLACEHOLDER_MISSING", "У личного вопроса нет сообщения для ответа", {
        details: { privateQuestionId: row.id },
      });
    }
    return await dependencies.telegram.edit({
      chatId: row.telegramChatId,
      content,
      ephemeralMessageId: row.placeholderEphemeralMessageId,
      receiverUserId: row.telegramUserId,
    });
  }

  /** Shows a closing text; the final state is recorded whatever Telegram does, so nothing stays "in progress". */
  async function close(row: PrivateQuestionRow, text: string, code: string, state: "cancelled" | "failed") {
    try {
      const shown = await show(row, { text });
      if (shown.kind === "rejected") {
        console.error(JSON.stringify({ code: "AGENT_PRIVATE_QUESTION_NOTICE_REJECTED", description: shown.description, privateQuestionId: row.id }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_PRIVATE_QUESTION_NOTICE_FAILED", error: error instanceof Error ? error.message : String(error), privateQuestionId: row.id,
      }));
    }
    await dependencies.store.changeById(row.id, { code, state });
    console.info(JSON.stringify({ code, privateQuestionId: row.id }));
  }

  return {
    async turnStarted(turn) {
      await dependencies.bindApplicationSession(attribute(turn, "applicationSessionId"), turn.sessionId);
    },
    async stepText() {},
    async toolsStarted() {},
    async inputRequested(event) {
      throw new AppError("AGENT_PRIVATE_QUESTION_INPUT_UNAVAILABLE", "Личный вопрос не может ждать подтверждения", {
        details: { turnId: event.turn.id },
      });
    },
    async turnFinished({ outcome, turn }) {
      const applicationSessionId = attribute(turn, "applicationSessionId");
      const row = await dependencies.store.findById(attribute(turn, "privateQuestionId"));
      if (row === null) {
        // Erased by retention or with its group: nothing is left to show, but the one-off session still retires.
        await dependencies.recordSessionTurn(applicationSessionId, turn.sessionId, outcome.status === "completed" ? "completed" : "failed");
        return;
      }
      if (outcome.status === "cancelled") {
        await close(row, PRIVATE_QUESTION_TEXTS.cancelled, PRIVATE_QUESTION_CODES.cancelled, "cancelled");
        await dependencies.recordSessionTurn(applicationSessionId, turn.sessionId, "failed");
        return;
      }
      if (outcome.status === "failed" || outcome.status === "waiting_input") {
        const unavailable = outcome.status === "failed" && outcome.code === MODEL_UNAVAILABLE_CODE;
        await close(
          row,
          unavailable ? PRIVATE_QUESTION_TEXTS.modelUnavailable : PRIVATE_QUESTION_TEXTS.failed,
          unavailable ? PRIVATE_QUESTION_CODES.modelUnavailable : PRIVATE_QUESTION_CODES.failed,
          "failed",
        );
        await dependencies.recordSessionTurn(applicationSessionId, turn.sessionId, "failed");
        return;
      }
      const answer = privateAnswerContent(outcome.text);
      if (answer.kind === "empty") {
        await close(row, PRIVATE_QUESTION_TEXTS.emptyAnswer, PRIVATE_QUESTION_CODES.emptyAnswer, "failed");
      } else if (answer.kind === "too_long") {
        await close(row, PRIVATE_QUESTION_TEXTS.tooLong, PRIVATE_QUESTION_CODES.tooLong, "failed");
      } else {
        let shown: Awaited<ReturnType<typeof show>>;
        try {
          shown = await show(row, { markdown: answer.markdown });
        } catch (error) {
          // The outcome of the edit is unknown (a lost connection, a group disconnected meanwhile): not repeated.
          console.error(JSON.stringify({
            code: "AGENT_PRIVATE_ANSWER_DELIVERY_FAILED", error: error instanceof Error ? error.message : String(error), privateQuestionId: row.id,
          }));
          await dependencies.store.changeById(row.id, { code: "AGENT_PRIVATE_ANSWER_DELIVERY_FAILED", state: "failed" });
          await dependencies.recordSessionTurn(applicationSessionId, turn.sessionId, "completed");
          return;
        }
        if (shown.kind === "rejected") {
          console.error(JSON.stringify({
            code: "AGENT_PRIVATE_ANSWER_REJECTED", description: shown.description, privateQuestionId: row.id, status: shown.status,
          }));
          await close(row, PRIVATE_QUESTION_TEXTS.failed, "AGENT_PRIVATE_ANSWER_REJECTED", "failed");
        } else {
          await dependencies.store.changeById(row.id, { answer: answer.markdown, state: "answered" });
          console.info(JSON.stringify({
            code: "AGENT_PRIVATE_QUESTION_ANSWERED", durationMs: Date.now() - row.receivedAt.getTime(), privateQuestionId: row.id,
          }));
        }
      }
      await dependencies.recordSessionTurn(applicationSessionId, turn.sessionId, "completed");
    },
  };
}
