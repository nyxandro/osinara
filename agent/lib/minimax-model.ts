/**
 * MiniMax model adapter for the internal OpenAI-compatible CLIProxy route.
 *
 * Exports:
 * - `createMiniMaxCliProxyModel`: creates a MiniMax chat model with separated
 *   reasoning and the MiniMax inline-reasoning normalizer middleware.
 *
 * Key constructs:
 * - `reasoning_split: true` is an integration invariant, not runtime configuration.
 * - `createMiniMaxInlineReasoningMiddleware` hides accidental provider reasoning tags
 *   before Eve or Telegram can treat them as visible answer text.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { wrapLanguageModel } from "ai";

import { createMiniMaxInlineReasoningMiddleware } from "./minimax-inline-reasoning.js";

const CLI_PROXY_PROVIDER_NAME = "cli-proxy-api";

interface MiniMaxCliProxyModelOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly fetch?: FetchFunction;
  readonly modelId: string;
}

export function createMiniMaxCliProxyModel(options: MiniMaxCliProxyModelOptions) {
  const provider = createOpenAICompatible({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    name: CLI_PROXY_PROVIDER_NAME,
    // MiniMax must return reasoning separately so Eve never receives it as message text.
    transformRequestBody: (body) => ({ ...body, reasoning_split: true }),
  });
  return wrapLanguageModel({
    middleware: createMiniMaxInlineReasoningMiddleware(),
    model: provider.chatModel(options.modelId),
  });
}
