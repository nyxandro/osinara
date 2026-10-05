/**
 * Failures of one model call and how the turn treats them.
 *
 * Exports:
 * - `EmptyModelResponseError`, `ModelInactivityError`, `TurnCancelledError`: the runtime's own
 *   model-call failures.
 * - `normalizeModelCallError`: maps an AI SDK failure onto them, keeping the original as cause.
 * - `classifyModelCallError`: `retry` (repeat this call now), `recoverable` (the turn fails, a
 *   person may retry) or `terminal` (the turn fails, repeating cannot help).
 * - `modelCallFailure`: the coded error a turn fails with after its model call gave up; a request
 *   over the model's window gets its own code, since repeating it cannot help.
 *
 * - An inactivity timeout is always retryable: tools never run inside a model call here, so a
 *   repeated call cannot repeat a side effect.
 * - AI SDK's exhausted transport retries end the call instead of being multiplied by the outer
 *   loop.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { APICallError } from "ai";

import { AppError } from "../../lib/app-error.js";

export type ModelCallFailureClass = "recoverable" | "retry" | "terminal";

export class EmptyModelResponseError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The model did not return a response. Please try again.", options);
    this.name = "EmptyModelResponseError";
  }
}

export type ModelInactivityCode = "AGENT_MODEL_FIRST_CHUNK_TIMEOUT" | "AGENT_MODEL_STREAM_TIMEOUT";

const INACTIVITY_MESSAGES: Record<ModelInactivityCode, string> = {
  AGENT_MODEL_FIRST_CHUNK_TIMEOUT: "Модель не начала отвечать вовремя. Попробуйте позже",
  AGENT_MODEL_STREAM_TIMEOUT: "Модель перестала отвечать до завершения ответа. Попробуйте позже",
};

export class ModelInactivityError extends AppError {
  constructor(code: ModelInactivityCode) {
    super(code, INACTIVITY_MESSAGES[code], { isRetryable: true });
    this.name = "ModelInactivityError";
  }
}

export class TurnCancelledError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The turn was cancelled.", options);
    this.name = "TurnCancelledError";
  }
}

const TRANSPORT_EXHAUSTED = "ModelTransportRetriesExhaustedError";

function* causeChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

function isTransportRetriesExhausted(error: Error): boolean {
  if (error.name !== "AI_RetryError" || !("reason" in error) || error.reason !== "maxRetriesExceeded") return false;
  const last = "lastError" in error ? error.lastError : undefined;
  return typeof last === "object" && last !== null && "isRetryable" in last && last.isRetryable === true;
}

export function normalizeModelCallError(error: unknown): unknown {
  if (!(error instanceof Error) || !isTransportRetriesExhausted(error)) return error;
  return Object.assign(new AppError(
    "AGENT_MODEL_TEMPORARILY_UNAVAILABLE",
    "Модель временно недоступна. Попробуйте позже",
    { cause: error },
  ), { name: TRANSPORT_EXHAUSTED });
}

function statusCode(error: unknown): number | undefined {
  for (const candidate of causeChain(error)) {
    const status = (candidate as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

export function classifyModelCallError(error: unknown): ModelCallFailureClass {
  for (const candidate of causeChain(error)) {
    const name = (candidate as { name?: unknown }).name;
    if (name === "TurnCancelledError" || name === TRANSPORT_EXHAUSTED) return "terminal";
  }
  // Its own reissue path repeats an empty answer once, with a notice; a plain retry would not.
  if (error instanceof EmptyModelResponseError) return "recoverable";
  for (const candidate of causeChain(error)) {
    if ((candidate as { isRetryable?: unknown }).isRetryable === true) return "retry";
  }
  const status = statusCode(error);
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 429 || status >= 500) return "retry";
    if (status >= 400) return "terminal";
  }
  return "recoverable";
}

// The OpenAI-compatible code for a request over the window; neuraldeep sends none (code "400",
// type "None", 5 October 2026) and says it only in its message.
const CONTEXT_OVERFLOW_CODE = "context_length_exceeded";
const CONTEXT_OVERFLOW_MESSAGE = /не помещается в контекстное окно/u;

function isContextOverflow(error: unknown): boolean {
  for (const candidate of causeChain(error)) {
    if (!APICallError.isInstance(candidate) || candidate.statusCode !== 400) continue;
    const code = (candidate.data as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (code === CONTEXT_OVERFLOW_CODE || CONTEXT_OVERFLOW_MESSAGE.test(candidate.message)) return true;
  }
  return false;
}

/** Cancellation passes through; every other failure becomes a coded error with its original as cause. */
export function modelCallFailure(error: unknown): unknown {
  if (error instanceof TurnCancelledError || error instanceof AppError) return error;
  if (error instanceof EmptyModelResponseError) {
    return new AppError("AGENT_MODEL_OUTPUT_INCOMPLETE", "Модель вернула пустой ответ. Попробуйте ещё раз", { cause: error });
  }
  if (classifyModelCallError(error) === "retry") {
    return new AppError("AGENT_MODEL_TEMPORARILY_UNAVAILABLE", "Модель временно недоступна. Попробуйте позже", {
      cause: error, isRetryable: true,
    });
  }
  if (isContextOverflow(error)) {
    return new AppError(
      "AGENT_MODEL_CONTEXT_OVERFLOW",
      "История разговора стала слишком длинной для модели, и ответить не удалось. Повторять запрос сразу бесполезно: при следующем сообщении ассистент попробует сжать историю",
      { cause: error },
    );
  }
  return new AppError("AGENT_MODEL_CALL_FAILED", "Модель не смогла обработать запрос. Попробуйте ещё раз", { cause: error });
}
