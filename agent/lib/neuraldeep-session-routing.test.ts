/**
 * NeuralDeep session-sticky model routing tests.
 *
 * Constructs covered:
 * - `resolveSessionModelSelection`: adds the runtime session identity only to NeuralDeep requests.
 * - Non-NeuralDeep providers keep their static model selection without provider options.
 */
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { resolveSessionModelSelection } from "./neuraldeep-session-routing.js";

const model = { modelId: "test-model", provider: "test-provider" } as LanguageModel;

describe("resolveSessionModelSelection", () => {
  it("uses the opaque session ID for NeuralDeep sticky routing", () => {
    expect(resolveSessionModelSelection({
      model,
      modelContextWindowTokens: 128_000,
      providerId: "neuraldeep",
      sessionId: "session_01CACHE",
    })).toEqual({
      contextWindowTokens: 128_000,
      model,
      providerOptions: { neuraldeep: { user: "session_01CACHE" } },
    });
  });

  it("does not add NeuralDeep provider options to another provider", () => {
    expect(resolveSessionModelSelection({
      model,
      modelContextWindowTokens: 128_000,
      providerId: "deepseek",
      sessionId: "session_01CACHE",
    })).toEqual({ contextWindowTokens: 128_000, model, providerOptions: undefined });
  });
});
