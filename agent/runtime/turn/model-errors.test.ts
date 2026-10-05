import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { AppError } from "../../lib/app-error.js";
import { classifyModelCallError, modelCallFailure } from "./model-errors.js";

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
