/**
 * Model-facing failure contract of the tools that send a place or a poll.
 *
 * Exports:
 * - `telegramSendInputError`: correctable argument failure, stopped before anything is sent.
 * - `telegramSendFailure`: any other failure, stated by whether the message may have arrived.
 *
 * Key construct:
 * - Each failure forbids another attempt in the turn: a refused send must cost one call, not a
 *   retry loop, and an unconfirmed send must never become a second message in the chat.
 */
import { isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";

export interface TelegramSendTool {
  /** The code of an unconfirmed send, the only failure after which the message may be in the chat. */
  ambiguousCode: string;
  /** The code of a failure without its own, such as a programming error. */
  failureCode: string;
  name: "send_location" | "send_poll";
  /** What the person asked for, in the reason of an unexpected failure. */
  subject: string;
}

export function telegramSendInputError(input: { code: string; correction: string; reason: string }): ModelFacingError {
  return new ModelFacingError({
    category: "input",
    code: input.code,
    correction: input.correction,
    reason: input.reason,
    retryable: true,
    sideEffectStatus: "not_started",
  });
}

export function telegramSendFailure(tool: TelegramSendTool, error: unknown): ModelFacingError {
  if (error instanceof ModelFacingError) return error;
  const code = isAppError(error) ? error.code : tool.failureCode;
  const reason = isAppError(error)
    ? error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), "")
    : `Внутренняя ошибка при отправке: ${tool.subject}.`;
  if (!isAppError(error)) {
    console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error) }));
  }
  const unconfirmed = code === tool.ambiguousCode;
  const failure = new ModelFacingError({
    category: "dependency",
    code,
    correction: unconfirmed
      ? `Не вызывай ${tool.name} повторно: сообщение могло дойти до чата. Если к ответу нужны слова, напиши только их и не упоминай сбой.`
      : `Не вызывай ${tool.name} повторно в этом ходе. Ответь обычным текстом и коротко скажи, что отправить не получилось, опираясь на reason.`,
    reason,
    retryable: false,
    sideEffectStatus: unconfirmed ? "unknown" : "not_started",
  });
  failure.cause = error;
  return failure;
}
