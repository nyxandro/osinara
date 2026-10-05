import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { AppError } from "../../lib/app-error.js";
import { classifyModelCallError, modelCallFailure } from "./model-errors.js";

// What neuraldeep answered to an oversized request on 5 October 2026: status 400, no telling code.
const NEURALDEEP_OVERFLOW = "Слишком длинный запрос — не помещается в контекстное окно модели. Сократите историю сообщений или max_tokens.";

function rejected(message: string, code = "400"): APICallError {
  return new APICallError({
    data: { error: { code, message, param: "None", type: "None" } },
    isRetryable: false,
    message,
    requestBodyValues: {},
    statusCode: 400,
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

  it("leaves any other rejected request a general model failure", () => {
    expect(modelCallFailure(rejected("Unknown model"))).toMatchObject({ code: "AGENT_MODEL_CALL_FAILED" });
  });
});
