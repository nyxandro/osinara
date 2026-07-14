/**
 * MiniMax model adapter for the internal OpenAI-compatible CLIProxy route.
 *
 * Exports:
 * - `createMiniMaxCliProxyModel`: creates a MiniMax chat model with separated
 *   reasoning and a fail-closed inline-reasoning contract validator.
 *
 * Key constructs:
 * - `reasoning_split: true` is an integration invariant, not runtime configuration.
 * - The patched OpenAI-compatible provider preserves exact `reasoning_details`
 *   metadata through assistant/tool history for interleaved thinking.
 * - Reserved reasoning boundaries in text fail the model call without rewriting it.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import {
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";

import { AppError } from "./app-error.js";

const CLI_PROXY_PROVIDER_NAME = "cli-proxy-api";
const MINI_MAX_REASONING_BOUNDARIES = [
  "<think",
  "</think",
  "<mm:think",
  "</mm:think",
  "<thinking",
  "</thinking",
] as const;
const MAX_REASONING_BOUNDARY_LENGTH = Math.max(
  ...MINI_MAX_REASONING_BOUNDARIES.map((boundary) => boundary.length),
);

interface MiniMaxCliProxyModelOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly fetch?: FetchFunction;
  readonly modelId: string;
}

function reasoningContractError(): AppError {
  return new AppError(
    "AGENT_MINIMAX_REASONING_CONTRACT_VIOLATION",
    "Модель вернула внутреннее рассуждение в тексте ответа. Попробуйте повторить запрос",
  );
}

function containsReasoningBoundary(text: string): boolean {
  const normalized = text.toLowerCase();
  return MINI_MAX_REASONING_BOUNDARIES.some((boundary) => normalized.includes(boundary));
}

function assertSeparatedContent(content: readonly LanguageModelV4Content[]): void {
  // `reasoning_split` guarantees that text parts contain only user-visible output.
  for (const part of content) {
    if (part.type === "text" && containsReasoningBoundary(part.text)) {
      throw reasoningContractError();
    }
  }
}

function reasoningContractMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      assertSeparatedContent(result.content);
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      const suffixes = new Map<string, string>();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type !== "text-delta") {
                controller.enqueue(part);
                return;
              }

              // Retain only enough prior text to detect an exact boundary split across chunks.
              const combined = `${suffixes.get(part.id) ?? ""}${part.delta}`;
              if (containsReasoningBoundary(combined)) {
                controller.error(reasoningContractError());
                return;
              }
              suffixes.set(part.id, combined.slice(-(MAX_REASONING_BOUNDARY_LENGTH - 1)));
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
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
    middleware: reasoningContractMiddleware(),
    model: provider.chatModel(options.modelId),
  });
}
