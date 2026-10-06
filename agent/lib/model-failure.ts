/** Model failure codes after which a memory review waits for the model instead of failing. */
export const RECOVERABLE_MODEL_CODES = [
  "AGENT_MODEL_FIRST_CHUNK_TIMEOUT", "AGENT_MODEL_STREAM_TIMEOUT",
  "AGENT_MODEL_OUTPUT_INCOMPLETE", "AGENT_MODEL_TEMPORARILY_UNAVAILABLE",
] as const;
export type RecoverableModelCode = (typeof RECOVERABLE_MODEL_CODES)[number];

export function isRecoverableModelCode(code: string): code is RecoverableModelCode {
  return (RECOVERABLE_MODEL_CODES as readonly string[]).includes(code);
}
