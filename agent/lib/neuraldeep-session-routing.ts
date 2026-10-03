/**
 * NeuralDeep session-sticky model routing.
 *
 * Exports:
 * - `resolveSessionModelSelection`: binds NeuralDeep requests to one upstream by the session ID.
 */
import type { LanguageModel } from "ai";

import type { StepModelSelection } from "../runtime/agent-definition.js";
import type { ModelProviderId } from "./model-provider-config.js";

interface SessionModelSelectionInput {
  readonly model: LanguageModel;
  readonly modelContextWindowTokens: number;
  readonly providerId: ModelProviderId;
  readonly sessionId: string;
}

export function resolveSessionModelSelection({
  model,
  modelContextWindowTokens,
  providerId,
  sessionId,
}: SessionModelSelectionInput): StepModelSelection {
  // NeuralDeep uses this OpenAI-compatible field for sticky upstream routing and KV-cache reuse.
  return {
    contextWindowTokens: modelContextWindowTokens,
    model,
    providerOptions: providerId === "neuraldeep" ? { neuraldeep: { user: sessionId } } : undefined,
  };
}
