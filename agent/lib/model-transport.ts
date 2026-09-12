/**
 * Protocol-native AI SDK model factory.
 *
 * Exports:
 * - `ConfiguredLanguageModelOptions`: explicit model, secret, transport, and test fetch inputs.
 * - `createConfiguredLanguageModel`: creates a standard AI SDK model by wire protocol.
 *
 * Key constructs:
 * - Anthropic Messages adaptive thinking is enforced at the transport boundary.
 * - Explicit MiniMax compatibility preserves provider web-search payloads across Anthropic parsing.
 * - Retryable physical provider responses are logged before AI SDK applies its bounded retry policy.
 * - OpenAI Chat Completions carries explicit provider-native thinking controls when configured.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";

import type { AgentModelTransport } from "./model-provider-config.js";
import { AppError } from "./app-error.js";
import { createMiniMaxAnthropicCompatibilityFetch } from "./minimax-anthropic-compatibility.js";
import { placeEphemeralMemoryContext } from "./model-turn-context.js";
import { createModelCallMetrics } from "./model-call-metrics.js";
import type { SuccessfulModelCall } from "./model-availability-repository.js";
import { modelRouteKey } from "./model-route.js";
import { modelSuccessObserver } from "./model-success-observer.js";

export interface ConfiguredLanguageModelOptions {
  readonly apiKey: string;
  readonly fetch?: FetchFunction;
  readonly maxOutputTokens: number;
  readonly modelId: string;
  readonly transport: AgentModelTransport;
  readonly onSuccessfulCall?: (event: SuccessfulModelCall) => Promise<void> | void;
}

const RETRYABLE_MODEL_HTTP_STATUS_CODES = new Set([408, 409, 429]);

function modelRequestUrl(input: Parameters<FetchFunction>[0]): string {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
  );
  // Query parameters are irrelevant to retry diagnosis and may contain provider credentials.
  return `${url.origin}${url.pathname}`;
}

function isRetryableModelResponse(response: Response): boolean {
  return RETRYABLE_MODEL_HTTP_STATUS_CODES.has(response.status) || response.status >= 500;
}

function createCredentialGuardedFetch(options: ConfiguredLanguageModelOptions): FetchFunction {
  return async (input, init) => {
    if (!options.apiKey || /\s/u.test(options.apiKey)) {
      throw new AppError(
        "AGENT_MODEL_API_KEY_INVALID",
        "Не задан корректный ключ доступа к основной модели",
      );
    }
    const response = await (options.fetch ?? globalThis.fetch)(input, init);
    if (isRetryableModelResponse(response)) {
      console.error(JSON.stringify({
        code: "AGENT_MODEL_TRANSIENT_RESPONSE",
        modelId: options.modelId,
        statusCode: response.status,
        url: modelRequestUrl(input),
      }));
    }
    return response;
  };
}

function configuredProviderOptions(
  existing: SharedV4ProviderOptions | undefined,
  transport: AgentModelTransport,
): SharedV4ProviderOptions {
  if (transport.protocol === "anthropic-messages") {
    if (transport.reasoning == null || transport.reasoning.type === "none") return {};
    return {
      anthropic: {
        ...existing?.anthropic,
        thinking: { type: "adaptive" },
      },
    };
  }
  if (transport.reasoning == null) return {};
  const reasoning = transport.reasoning;
  if (reasoning.format === "reasoning-object") {
    return {
      [transport.providerName]: {
        ...existing?.[transport.providerName],
        reasoning: reasoning.type === "none" ? { effort: "none" } : { effort: reasoning.effort },
      },
    };
  }
  if (reasoning.format === "reasoning-effort") {
    return {
      [transport.providerName]: {
        ...existing?.[transport.providerName],
        reasoningEffort: reasoning.type === "effort" ? reasoning.effort : "none",
      },
    };
  }
  return {
    [transport.providerName]: {
      ...existing?.[transport.providerName],
      ...(reasoning.type === "effort"
        ? { reasoningEffort: reasoning.effort }
        : {}),
      thinking: { type: reasoning.type === "effort" ? "enabled" : "disabled" },
    },
  };
}

function removeUnresolvedOpenAIToolCalls(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  // AI SDK treats a client-side approval as resolving its call, then removes the approval response
  // from provider input. OpenAI-compatible APIs require immediate results for every retained call.
  const normalized: LanguageModelV4Prompt = [];
  for (let index = 0; index < prompt.length;) {
    const message = prompt[index]!;
    if (message.role !== "assistant") {
      // A tool message outside its originating assistant group is invalid provider history.
      if (message.role !== "tool") normalized.push(message);
      index += 1;
      continue;
    }

    // Only contiguous tool messages can complete this assistant turn under Chat Completions.
    let nextIndex = index + 1;
    const toolMessages: Extract<LanguageModelV4Prompt[number], { role: "tool" }>[] = [];
    while (prompt[nextIndex]?.role === "tool") {
      toolMessages.push(prompt[nextIndex] as typeof toolMessages[number]);
      nextIndex += 1;
    }
    const immediateResultIds = new Set(toolMessages.flatMap((toolMessage) =>
      toolMessage.content
        .filter((part) => part.type === "tool-result")
        .map((part) => part.toolCallId)
    ));
    const retainedCallIds = new Set<string>();
    for (const part of message.content) {
      if (part.type === "tool-call" && immediateResultIds.has(part.toolCallId)) {
        retainedCallIds.add(part.toolCallId);
      }
    }
    const content = message.content.filter((part) =>
      part.type !== "tool-call" || retainedCallIds.has(part.toolCallId)
    );
    if (content.length > 0) normalized.push({ ...message, content });
    for (const toolMessage of toolMessages) {
      const toolContent = toolMessage.content.filter((part) =>
        part.type === "tool-approval-response" || retainedCallIds.has(part.toolCallId)
      );
      if (toolContent.length > 0) normalized.push({ ...toolMessage, content: toolContent });
    }
    index = nextIndex;
  }
  return normalized;
}

function createTransportDefaultsMiddleware(
  maxOutputTokens: number,
  transport: AgentModelTransport,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async transformParams({ params }) {
      return {
        ...params,
        maxOutputTokens: params.maxOutputTokens ?? maxOutputTokens,
        prompt: placeEphemeralMemoryContext(transport.protocol === "openai-chat-completions"
          ? removeUnresolvedOpenAIToolCalls(params.prompt)
          : params.prompt),
        providerOptions: {
          ...params.providerOptions,
          ...configuredProviderOptions(params.providerOptions, transport),
        },
      };
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      assertCompleteFinishReason(result.finishReason);
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === "finish") assertCompleteFinishReason(part.finishReason);
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

function assertCompleteFinishReason(finishReason: LanguageModelV4FinishReason): void {
  if (finishReason.unified === "stop" || finishReason.unified === "tool-calls") return;
  if (finishReason.unified === "length") {
    throw new AppError(
      "AGENT_MODEL_OUTPUT_TRUNCATED",
      "Модель оборвала ответ из-за ограничения длины. Сократите запрос или попросите ответить частями",
    );
  }
  if (finishReason.unified === "content-filter") {
    throw new AppError(
      "AGENT_MODEL_OUTPUT_FILTERED",
      "Модель остановила ответ из-за ограничений безопасности. Переформулируйте запрос",
    );
  }
  // An unfinished answer means the provider stream broke, not that the request was wrong. Marking
  // it retryable is what lets Eve reissue this one call: truncation by length and a content filter
  // stay terminal above, because repeating either produces the same result.
  throw new AppError(
    "AGENT_MODEL_OUTPUT_INCOMPLETE",
    "Модель не завершила ответ. Попробуйте повторить запрос или сформулировать его иначе",
    { isRetryable: true },
  );
}

export function createConfiguredLanguageModel(options: ConfiguredLanguageModelOptions) {
  const { transport } = options;
  const metrics = createModelCallMetrics({
    modelId: options.modelId,
    protocol: transport.protocol,
    provider: transport.protocol === "anthropic-messages" ? "anthropic" : transport.providerName,
  });
  const guardedFetch = createCredentialGuardedFetch(options);
  const middleware = [
    ...(options.onSuccessfulCall ? [modelSuccessObserver(modelRouteKey(transport, options.modelId), options.onSuccessfulCall)] : []),
    createTransportDefaultsMiddleware(options.maxOutputTokens, transport), metrics,
  ];
  if (transport.protocol === "anthropic-messages") {
    const fetch = transport.compatibility === "minimax-anthropic"
      ? createMiniMaxAnthropicCompatibilityFetch(guardedFetch)
      : guardedFetch;
    const provider = createAnthropic({
      baseURL: transport.baseUrl,
      ...(transport.authentication === "bearer"
        ? { authToken: options.apiKey }
        : { apiKey: options.apiKey }),
      fetch,
    });
    return wrapLanguageModel({
      middleware,
      model: provider(options.modelId),
    });
  }

  const provider = createOpenAICompatible({
    apiKey: options.apiKey,
    baseURL: transport.baseUrl,
    fetch: guardedFetch,
    name: transport.providerName,
    includeUsage: true,
  });
  return wrapLanguageModel({
    middleware,
    model: provider.chatModel(options.modelId),
  });
}
