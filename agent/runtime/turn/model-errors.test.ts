import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { AppError } from "../../lib/app-error.js";
import {
  classifyModelCallError, isRequestRefusal, modelCallFailure, ModelInactivityError, normalizeModelCallError,
} from "./model-errors.js";

// What neuraldeep answered to an oversized request on 5 October 2026: status 400, no telling code.
const NEURALDEEP_OVERFLOW = "Слишком длинный запрос — не помещается в контекстное окно модели. Сократите историю сообщений или max_tokens.";

function rejected(message: string, code = "400", statusCode = 400): APICallError {
  return new APICallError({
    data: { error: { code, message, param: "None", type: "None" } },
    isRetryable: statusCode >= 500,
    message,
    requestBodyValues: {},
    statusCode,
    url: "https://api.neuraldeep.ru/v1/chat/completions",
  });
}

describe("model call failures", () => {
  it("names a request that does not fit the model's window and keeps the provider's error as cause", () => {
    const error = rejected(NEURALDEEP_OVERFLOW);

    const failure = modelCallFailure(error);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ cause: error, code: "AGENT_MODEL_CONTEXT_OVERFLOW", isRetryable: false });
    expect(classifyModelCallError(error)).toBe("terminal");
  });

  it("names the OpenAI-compatible context_length_exceeded code the same way", () => {
    expect(modelCallFailure(rejected("This model's maximum context length is 8192 tokens.", "context_length_exceeded")))
      .toMatchObject({ code: "AGENT_MODEL_CONTEXT_OVERFLOW" });
  });

  it("names an overflow that came after the SDK retried a temporary failure", () => {
    // A retried call ends in a RetryError that keeps its attempts in `errors`, not in `cause`.
    const error = new RetryError({
      errors: [rejected("Service Unavailable", "503", 503), rejected(NEURALDEEP_OVERFLOW)],
      message: "Failed after 2 attempts with non-retryable error",
      reason: "errorNotRetryable",
    });

    expect(modelCallFailure(error)).toMatchObject({ code: "AGENT_MODEL_CONTEXT_OVERFLOW" });
  });

  it("does not take the overflow wording for an overflow when the status is not a rejected request", () => {
    expect(modelCallFailure(rejected(NEURALDEEP_OVERFLOW, "500", 500))).toMatchObject({ code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE" });
  });

  it("leaves any other rejected request a general model failure", () => {
    expect(modelCallFailure(rejected("Unknown model"))).toMatchObject({ code: "AGENT_MODEL_CALL_FAILED" });
  });
});

describe("isRequestRefusal", () => {
  // #331: a summary the model turned down is asked for smaller next time, and after four refusals
  // the older history is dropped. A broken key or an unpaid account fails every request, not
  // this one: counting it would drop history a person never lost to a refusal.
  // The summary call retries inside the SDK, which ends an outage in a RetryError with no status
  // and no cause of its own; the summary path normalizes it the way the main model call does.
  const retried = (reason: "errorNotRetryable" | "maxRetriesExceeded", ...errors: APICallError[]) =>
    new RetryError({ errors, message: "Failed after retries", reason });

  it.each([
    ["an oversized request", rejected(NEURALDEEP_OVERFLOW), true],
    ["a request the provider rejected", rejected("content policy violation"), true],
    ["a request rejected after a retried outage",
      retried("errorNotRetryable", rejected("overloaded", "503", 503), rejected("content policy violation")), true],
    ["a failure without a status", new Error("refused: input is too long for this model"), true],
    ["a summary the content filter stopped", new AppError("AGENT_MODEL_OUTPUT_FILTERED", "Ограничения безопасности"), true],
    ["a summary cut at the length limit", new AppError("AGENT_MODEL_OUTPUT_TRUNCATED", "Ограничение длины"), true],
    ["a broken key", rejected("invalid api key", "401", 401), false],
    ["a broken key after a retried outage",
      retried("errorNotRetryable", rejected("overloaded", "503", 503), rejected("invalid api key", "401", 401)), false],
    ["an unpaid account", rejected("insufficient balance", "402", 402), false],
    ["a forbidden model", rejected("access denied", "403", 403), false],
    ["a model that is gone", rejected("Unknown model", "404", 404), false],
    ["a provider outage", rejected("overloaded", "503", 503), false],
    ["a provider outage the SDK retried to the end", retried("maxRetriesExceeded",
      rejected("overloaded", "503", 503), rejected("overloaded", "503", 503), rejected("overloaded", "503", 503)), false],
    ["a provider stream that broke off",
      new AppError("AGENT_MODEL_OUTPUT_INCOMPLETE", "Модель не завершила ответ", { isRetryable: true }), false],
    ["a model that never answered", new ModelInactivityError("AGENT_MODEL_FIRST_CHUNK_TIMEOUT"), false],
  ])("counts %s: %s", (_, error, expected) => {
    expect(isRequestRefusal(modelCallFailure(normalizeModelCallError(error)))).toBe(expected);
  });
});
