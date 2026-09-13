/** Provider failures remain distinct from source material, including Exa's unflagged quota response. */
import { ModelFacingError } from "../model-facing-error.js";

const REASONS = {
  AGENT_WEB_SEARCH_FAILED: "Поиск в интернете сейчас недоступен.",
  AGENT_WEB_SEARCH_RATE_LIMITED: "Сервис поиска исчерпал доступный лимит запросов.",
  AGENT_WEB_SEARCH_TIMEOUT: "Сервис поиска не ответил за отведённое время.",
  AGENT_WEB_SEARCH_RESPONSE_INVALID: "Сервис поиска вернул ответ, который невозможно прочитать.",
  AGENT_WEB_SEARCH_RESPONSE_TOO_LARGE: "Ответ сервиса поиска превышает допустимый размер.",
} as const;

export function searchError(code: keyof typeof REASONS = "AGENT_WEB_SEARCH_FAILED", cause?: unknown): ModelFacingError {
  const error = new ModelFacingError({
    category: "dependency", code, reason: REASONS[code], retryable: false, sideEffectStatus: "not_started",
    correction: "Не повторяйте этот вызов автоматически. Продолжите независимые части задачи; укажите, какие сведения не удалось проверить.",
  });
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function isExaQuotaNotice(text: string): boolean {
  // Match the provider's observed standalone banner, not articles mentioning quota errors.
  return text.trimStart().startsWith("You've hit Exa's free MCP rate limit.");
}

export function normalizeSearchFailure(error: unknown): ModelFacingError {
  if (error instanceof ModelFacingError) return error;
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return searchError("AGENT_WEB_SEARCH_TIMEOUT", error);
  }
  if (error instanceof SyntaxError || (error instanceof TypeError && "code" in error && error.code === "ERR_ENCODING_INVALID_ENCODED_DATA")) {
    return searchError("AGENT_WEB_SEARCH_RESPONSE_INVALID", error);
  }
  return searchError("AGENT_WEB_SEARCH_FAILED", error);
}
