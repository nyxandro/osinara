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

// The owner's account is the owner's business: anyone else, a guest included, learns only that the
// voice note did not work this time, while the owner gets the cause in a message of their own (#480).
const ACCOUNT_REFUSAL_CODES = new Set([
  "AGENT_VOICE_MESSAGE_CONFIG_MISSING",
  "AGENT_VOICE_MESSAGE_PROVIDER_ACCESS_DENIED",
  "AGENT_VOICE_MESSAGE_PROVIDER_PAYMENT_REQUIRED",
]);
const PRIVATE_ACCOUNT_REASON = "Голосовое сейчас недоступно.";
const PRIVATE_ACCOUNT_CODE = "AGENT_VOICE_MESSAGE_UNAVAILABLE";

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

/** `ownerChat`: the owner's own private chat, the only place the account's cause may be named. */
export function voiceMessageFailure(error: unknown, options: { ownerChat: boolean } = { ownerChat: true }): ModelFacingError {
  if (error instanceof ModelFacingError) return error;
  const actualCode = isAppError(error) ? error.code : "AGENT_VOICE_MESSAGE_FAILED";
  // Even the code would tell a guest what the owner's account lacks; the ledger and the owner's
  // message keep the real one.
  const privateAccount = !options.ownerChat && ACCOUNT_REFUSAL_CODES.has(actualCode);
  const code = privateAccount ? PRIVATE_ACCOUNT_CODE : actualCode;
  const reason = !isAppError(error)
    ? UNEXPECTED_FAILURE_REASON
    : privateAccount
      ? PRIVATE_ACCOUNT_REASON
      : error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), "");
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
