/**
 * Model-facing failure contract of the voice message tool.
 *
 * Exports:
 * - `voiceMessageInputError`: correctable argument failure.
 * - `voiceMessageFailure`: any other failure, stated by whether the voice note may have arrived.
 *
 * Key construct:
 * - The owner-defined recovery path for a failed voice note is a text answer to the same request.
 *   Every failure therefore forbids another voice attempt in this turn and names that path, so an
 *   exhausted ElevenLabs balance degrades to a text reply instead of a retry loop or silence.
 */
import { isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";

// Only these outcomes leave open whether Telegram already shows the voice note to the chat.
const DELIVERY_UNCONFIRMED_CODES = new Set([
  "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
]);

const TEXT_REPLY_CORRECTION =
  "Не вызывай send_voice_message повторно в этом ходе. Ответь на ту же просьбу обычным текстом и первой фразой коротко скажи, что голосовое сейчас не получилось, опираясь на reason, поэтому отвечаешь текстом.";

const UNCONFIRMED_DELIVERY_CORRECTION =
  "Не вызывай send_voice_message повторно: голосовое могло дойти до чата. Ответь на ту же просьбу обычным текстом и первой фразой коротко скажи, что не удалось подтвердить отправку голосового, поэтому дублируешь ответ текстом.";

const UNEXPECTED_FAILURE_REASON = "Внутренняя ошибка при отправке голосового сообщения.";

export function voiceMessageInputError(): ModelFacingError {
  return new ModelFacingError({
    category: "input",
    code: "AGENT_VOICE_MESSAGE_INPUT_INVALID",
    correction:
      "Передай только text с непустым текстом для озвучки не длиннее 5000 символов и при необходимости короткий caption: Telegram ограничивает подпись 1024 символами после разметки ссылок. Затем повтори вызов один раз.",
    reason: "Параметры голосового сообщения не прошли проверку.",
    retryable: true,
    sideEffectStatus: "not_started",
  });
}

export function voiceMessageFailure(error: unknown): ModelFacingError {
  if (error instanceof ModelFacingError) return error;
  const code = isAppError(error) ? error.code : "AGENT_VOICE_MESSAGE_FAILED";
  const reason = isAppError(error)
    ? error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), "")
    : UNEXPECTED_FAILURE_REASON;
  if (!isAppError(error)) {
    console.error(JSON.stringify({
      code,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  const unconfirmed = DELIVERY_UNCONFIRMED_CODES.has(code);
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
