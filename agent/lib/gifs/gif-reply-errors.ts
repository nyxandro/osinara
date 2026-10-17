/**
 * Model-facing failure contract of the GIF reply tool.
 *
 * Exports:
 * - `gifReplyInputError`: correctable argument failure.
 * - `gifReplyFailure`: any other failure, stated by whether the GIF may have arrived.
 *
 * Key construct:
 * - A GIF only decorates an answer, so the recovery path of every failure is the same answer in
 *   text. Each failure forbids another attempt in the turn: a failing provider must cost one call,
 *   not a retry loop, and an unconfirmed send must never become a second GIF.
 */
import { isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";

const TEXT_REPLY_CORRECTION =
  "Не вызывай send_gif повторно в этом ходе. Ответь на сообщение обычным текстом; если человек прямо просил гифку, коротко скажи, что сейчас не получилось, опираясь на reason.";

const UNCONFIRMED_DELIVERY_CORRECTION =
  "Не вызывай send_gif повторно: гифка могла дойти до чата. Если к ответу нужны слова, напиши только их и не упоминай сбой гифки.";

const UNEXPECTED_FAILURE_REASON = "Внутренняя ошибка при отправке гифки.";

export function gifReplyInputError(): ModelFacingError {
  return new ModelFacingError({
    category: "input",
    code: "AGENT_GIF_REPLY_INPUT_INVALID",
    correction:
      "Передай query — от одного до пяти английских слов не длиннее 100 символов, brief — непустое описание ответа не длиннее 1000 символов и при необходимости короткий caption: Telegram ограничивает подпись 1024 символами после разметки ссылок. Других полей не передавай. Затем повтори вызов один раз.",
    reason: "Параметры гифки не прошли проверку.",
    retryable: true,
    sideEffectStatus: "not_started",
  });
}

export function gifReplyFailure(error: unknown): ModelFacingError {
  if (error instanceof ModelFacingError) return error;
  const code = isAppError(error) ? error.code : "AGENT_GIF_REPLY_FAILED";
  const reason = isAppError(error)
    ? error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), "")
    : UNEXPECTED_FAILURE_REASON;
  if (!isAppError(error)) {
    console.error(JSON.stringify({
      code,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  const unconfirmed = code === "AGENT_GIF_DELIVERY_AMBIGUOUS";
  const failure = new ModelFacingError({
    category: "dependency",
    code,
    correction: unconfirmed ? UNCONFIRMED_DELIVERY_CORRECTION : TEXT_REPLY_CORRECTION,
    reason,
    retryable: false,
    sideEffectStatus: unconfirmed ? "unknown" : "not_started",
  });
  failure.cause = error;
  return failure;
}
