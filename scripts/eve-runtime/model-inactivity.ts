/** Native AI SDK inactivity policy, installed into Eve's ToolLoopAgent by the pinned patch. */
// Conservative initial window: the measured successful Qwen probes finished within 36 seconds,
// while some 90-second probes still produced reasoning. Activity must not be a total-time limit.
export const MODEL_INACTIVITY_TIMEOUT = Object.freeze({
  firstChunkMs: 5 * 60 * 1000,
  chunkMs: 5 * 60 * 1000,
});

const TIMEOUT_MESSAGES = {
  AGENT_MODEL_FIRST_CHUNK_TIMEOUT: "Модель не начала отвечать вовремя. Попробуйте позже",
  AGENT_MODEL_STREAM_TIMEOUT: "Модель перестала отвечать до завершения ответа. Попробуйте позже",
} as const;

/** The pinned SDK emits these codes; no provider prose or generic AbortError is classified here. */
export function normalizeModelInactivityError(error: unknown, toolsStarted: boolean): unknown {
  if (!(error instanceof Error)) return error;
  if (error.name === "AI_RetryError" && "reason" in error && error.reason === "maxRetriesExceeded" &&
      "lastError" in error && typeof error.lastError === "object" && error.lastError !== null &&
      "isRetryable" in error.lastError && error.lastError.isRetryable === true) {
    // The SDK has already exhausted its transport budget. Preserve the reason without multiplying
    // that budget by Eve's outer retry loop or letting task mode retry the whole durable step.
    return Object.assign(new Error(
      "AGENT_MODEL_TEMPORARILY_UNAVAILABLE: Модель временно недоступна. Попробуйте позже", { cause: error },
    ), { name: "ModelTransportRetriesExhaustedError", isRetryable: false });
  }
  if (error.name !== "TimeoutError" && error.name !== "AbortError") return error;
  for (const [code, message] of Object.entries(TIMEOUT_MESSAGES)) {
    if (error.message !== code && error.message !== `TimeoutError: ${code}`) continue;
    const normalized = new Error(`${code}: ${message}`, { cause: error });
    Object.assign(normalized, {
      code,
      isRetryable: !toolsStarted,
      name: toolsStarted ? "ModelInactivityAfterToolError" : "ModelInactivityTimeoutError",
    });
    return normalized;
  }
  return error;
}
