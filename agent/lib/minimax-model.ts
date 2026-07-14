/**
 * MiniMax model adapter for the internal OpenAI-compatible CLIProxy route.
 *
 * Exports:
 * - `createMiniMaxCliProxyModel`: creates a MiniMax chat model with separated
 *   reasoning and a fail-closed inline-reasoning normalizer.
 *
 * Key constructs:
 * - `reasoning_split: true` is an integration invariant, not runtime configuration.
 * - The patched OpenAI-compatible provider preserves exact `reasoning_details`
 *   metadata through assistant/tool history for interleaved thinking.
 * - Complete inline reasoning blocks become SDK reasoning parts when MiniMax violates
 *   `reasoning_split`; malformed boundaries still fail without exposing their content.
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
const MINI_MAX_REASONING_TAGS = ["think", "mm:think", "thinking"] as const;
const MINI_MAX_REASONING_BOUNDARIES = MINI_MAX_REASONING_TAGS.flatMap((tag) => [
  { closing: false, tag, token: `<${tag}>` },
  { closing: true, tag, token: `</${tag}>` },
]);
const MINI_MAX_RESERVED_BOUNDARY_PREFIXES = [
  "<think",
  "</think",
  "<mm:think",
  "</mm:think",
] as const;

type InlineReasoningEvent =
  | { readonly text: string; readonly type: "text" }
  | { readonly sequence: number; readonly type: "reasoning-start" }
  | { readonly sequence: number; readonly text: string; readonly type: "reasoning-delta" }
  | { readonly sequence: number; readonly type: "reasoning-end" };

interface InlineReasoningState {
  buffer: string;
  mode: "text" | "reasoning";
  reasoningSequence: number;
}

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

function createInlineReasoningState(): InlineReasoningState {
  return {
    buffer: "",
    mode: "text",
    reasoningSequence: 0,
  };
}

function emitInlineText(
  state: InlineReasoningState,
  events: InlineReasoningEvent[],
  text: string,
): void {
  if (!text) return;
  if (state.mode === "text") {
    events.push({ text, type: "text" });
    return;
  }
  events.push({ sequence: state.reasoningSequence, text, type: "reasoning-delta" });
}

function applyReasoningBoundary(
  state: InlineReasoningState,
  events: InlineReasoningEvent[],
  boundary: typeof MINI_MAX_REASONING_BOUNDARIES[number],
): void {
  // Nested openings are ambiguous because they can expose an incomplete reasoning block.
  if (!boundary.closing) {
    if (state.mode !== "text") throw reasoningContractError();
    state.mode = "reasoning";
    state.reasoningSequence += 1;
    events.push({ sequence: state.reasoningSequence, type: "reasoning-start" });
    return;
  }

  // MiniMax can send reasoning structurally while leaving its closing separator in content.
  if (state.mode === "text") return;
  events.push({ sequence: state.reasoningSequence, type: "reasoning-end" });
  state.mode = "text";
}

function consumeInlineReasoning(
  state: InlineReasoningState,
  input: string,
  final: boolean,
): InlineReasoningEvent[] {
  const events: InlineReasoningEvent[] = [];
  state.buffer += input;

  // Emit ordinary content immediately, retaining only a possible split tag at the buffer edge.
  while (state.buffer) {
    const boundaryStart = state.buffer.indexOf("<");
    if (boundaryStart === -1) {
      emitInlineText(state, events, state.buffer);
      state.buffer = "";
      break;
    }
    if (boundaryStart > 0) {
      emitInlineText(state, events, state.buffer.slice(0, boundaryStart));
      state.buffer = state.buffer.slice(boundaryStart);
      continue;
    }

    const normalized = state.buffer.toLowerCase();
    const boundary = MINI_MAX_REASONING_BOUNDARIES.find(({ token }) =>
      normalized.startsWith(token)
    );
    if (boundary) {
      applyReasoningBoundary(state, events, boundary);
      state.buffer = state.buffer.slice(boundary.token.length);
      continue;
    }

    const couldBecomeBoundary = MINI_MAX_REASONING_BOUNDARIES.some(({ token }) =>
      token.startsWith(normalized)
    );
    if (couldBecomeBoundary && !final) break;

    // Reserved starts with unsupported attributes or incomplete final tags must never be visible.
    const malformedBoundary = MINI_MAX_RESERVED_BOUNDARY_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix)
    );
    if (malformedBoundary || (final && couldBecomeBoundary)) throw reasoningContractError();
    emitInlineText(state, events, state.buffer[0]!);
    state.buffer = state.buffer.slice(1);
  }

  // A completed provider response cannot leave internal reasoning open across model calls.
  if (final && state.mode === "reasoning") throw reasoningContractError();
  return events;
}

function normalizeGeneratedContent(
  content: readonly LanguageModelV4Content[],
): LanguageModelV4Content[] {
  const normalized: LanguageModelV4Content[] = [];
  for (const part of content) {
    if (part.type !== "text") {
      normalized.push(part);
      continue;
    }

    // Non-streaming responses use the same parser so both provider paths enforce one contract.
    const state = createInlineReasoningState();
    const events = [
      ...consumeInlineReasoning(state, part.text, false),
      ...consumeInlineReasoning(state, "", true),
    ];
    for (const event of events) {
      if (event.type === "text") {
        normalized.push({
          ...(part.providerMetadata === undefined
            ? {}
            : { providerMetadata: part.providerMetadata }),
          text: event.text,
          type: "text",
        });
      } else if (event.type === "reasoning-delta") {
        normalized.push({
          ...(part.providerMetadata === undefined
            ? {}
            : { providerMetadata: part.providerMetadata }),
          text: event.text,
          type: "reasoning",
        });
      }
    }
  }
  return normalized;
}

function inlineReasoningMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      return { ...result, content: normalizeGeneratedContent(result.content) };
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      const delayedTextStarts = new Map<
        string,
        Extract<LanguageModelV4StreamPart, { type: "text-start" }>
      >();
      const startedTextIds = new Set<string>();
      const states = new Map<string, InlineReasoningState>();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === "text-start") {
                // Delay the visible part until inline reasoning has been emitted in semantic order.
                delayedTextStarts.set(part.id, part);
                startedTextIds.delete(part.id);
                states.set(part.id, createInlineReasoningState());
                return;
              }
              if (part.type === "text-delta") {
                const state = states.get(part.id) ?? createInlineReasoningState();
                states.set(part.id, state);
                const events = consumeInlineReasoning(state, part.delta, false);
                enqueueStreamEvents(
                  controller,
                  part,
                  events,
                  delayedTextStarts,
                  startedTextIds,
                );
                return;
              }
              if (part.type === "text-end") {
                const state = states.get(part.id);
                if (state) {
                  enqueueStreamEvents(
                    controller,
                    part,
                    consumeInlineReasoning(state, "", true),
                    delayedTextStarts,
                    startedTextIds,
                  );
                  states.delete(part.id);
                }
                ensureTextStarted(controller, part.id, delayedTextStarts, startedTextIds);
                controller.enqueue(part);
                delayedTextStarts.delete(part.id);
                startedTextIds.delete(part.id);
                return;
              }
              if (part.type === "finish") {
                // Some compatible providers omit text-end; finish is the final fail-closed boundary.
                for (const [id, state] of states) {
                  enqueueStreamEvents(
                    controller,
                    { delta: "", id, type: "text-delta" },
                    consumeInlineReasoning(state, "", true),
                    delayedTextStarts,
                    startedTextIds,
                  );
                  ensureTextStarted(controller, id, delayedTextStarts, startedTextIds);
                  controller.enqueue({ id, type: "text-end" });
                  delayedTextStarts.delete(id);
                  startedTextIds.delete(id);
                }
                states.clear();
              }
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

function ensureTextStarted(
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  id: string,
  delayedTextStarts: Map<
    string,
    Extract<LanguageModelV4StreamPart, { type: "text-start" }>
  >,
  startedTextIds: Set<string>,
): void {
  if (startedTextIds.has(id)) return;
  controller.enqueue(delayedTextStarts.get(id) ?? { id, type: "text-start" });
  delayedTextStarts.delete(id);
  startedTextIds.add(id);
}

function enqueueStreamEvents(
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  source: Extract<
    LanguageModelV4StreamPart,
    { type: "text-delta" | "text-end" }
  >,
  events: readonly InlineReasoningEvent[],
  delayedTextStarts: Map<
    string,
    Extract<LanguageModelV4StreamPart, { type: "text-start" }>
  >,
  startedTextIds: Set<string>,
): void {
  for (const event of events) {
    if (event.type === "text") {
      ensureTextStarted(controller, source.id, delayedTextStarts, startedTextIds);
      controller.enqueue({
        delta: event.text,
        id: source.id,
        ...(source.providerMetadata === undefined
          ? {}
          : { providerMetadata: source.providerMetadata }),
        type: "text-delta",
      });
      continue;
    }

    // A stable derived ID keeps each recovered reasoning block distinct from visible text.
    const id = `${source.id}:inline-reasoning:${event.sequence}`;
    const providerMetadata = source.providerMetadata === undefined
      ? {}
      : { providerMetadata: source.providerMetadata };
    if (event.type === "reasoning-start") {
      controller.enqueue({ id, ...providerMetadata, type: "reasoning-start" });
    } else if (event.type === "reasoning-delta") {
      controller.enqueue({
        delta: event.text,
        id,
        ...providerMetadata,
        type: "reasoning-delta",
      });
    } else {
      controller.enqueue({ id, ...providerMetadata, type: "reasoning-end" });
    }
  }
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
    middleware: inlineReasoningMiddleware(),
    model: provider.chatModel(options.modelId),
  });
}
