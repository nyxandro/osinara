/** Translate trusted Eve failure envelopes into a small, explicit recovery contract. */
export const RECOVERABLE_MODEL_CODES = [
  "AGENT_MODEL_FIRST_CHUNK_TIMEOUT", "AGENT_MODEL_STREAM_TIMEOUT",
  "AGENT_MODEL_OUTPUT_INCOMPLETE", "AGENT_MODEL_TEMPORARILY_UNAVAILABLE",
] as const;
export type RecoverableModelCode = (typeof RECOVERABLE_MODEL_CODES)[number];

export function isRecoverableModelCode(code: string): code is RecoverableModelCode {
  return (RECOVERABLE_MODEL_CODES as readonly string[]).includes(code);
}

export function recoverableModelFailureCode(data: {
  code: string; message?: string; details?: Record<string, unknown>;
}): RecoverableModelCode | null {
  if (isRecoverableModelCode(data.code)) return data.code;
  if (data.code !== "MODEL_CALL_FAILED") return null;
  // Eve's catalog classifies socket/DNS/connection failures even when no HTTP status exists.
  if (data.details?.semanticErrorId === "network-request-failed") return "AGENT_MODEL_TEMPORARILY_UNAVAILABLE";
  if (data.details?.semanticErrorId === "empty-model-response") return "AGENT_MODEL_OUTPUT_INCOMPLETE";
  for (const code of RECOVERABLE_MODEL_CODES) {
    if (data.message?.startsWith(`${code}:`)) return code;
  }
  const status = data.details?.statusCode ?? data.details?.upstreamStatusCode;
  if (typeof status === "number" && Number.isInteger(status) &&
      ([408, 409, 429].includes(status) || status >= 500 && status <= 599)) {
    return "AGENT_MODEL_TEMPORARILY_UNAVAILABLE";
  }
  return null;
}
