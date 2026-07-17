/**
 * MiniMax inline reasoning middleware.
 *
 * Exports:
 * - `createMiniMaxInlineReasoningMiddleware`: AI SDK middleware that converts accidental
 *   MiniMax inline `<think>` blocks into hidden SDK reasoning parts.
 *
 * Key constructs:
 * - `normalizeGeneratedContent`: normalizes non-streaming model output.
 * - `enqueueStreamEvents`: converts parser events into SDK stream parts.
 * - `isStreamDeliverable`: detects visible or actionable output before finish.
 */
import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";

import {
  consumeInlineReasoning,
  createInlineReasoningState,
  emptyVisibleAnswerError,
  finalizeInlineReasoning,
  type InlineReasoningEvent,
  type InlineReasoningState,
} from "./minimax-inline-reasoning-parser.js";

const INLINE_REASONING_ID_SEPARATOR = ":inline-reasoning:";

function isGeneratedDeliverable(part: LanguageModelV4Content): boolean {
  if (part.type === "reasoning") return false;
  if (part.type === "text") return part.text.trim().length > 0;
  return true;
}

function assertGeneratedOutputHasDeliverable(content: readonly LanguageModelV4Content[]): void {
  if (content.some(isGeneratedDeliverable)) return;
  throw emptyVisibleAnswerError();
}

function isStreamDeliverable(part: LanguageModelV4StreamPart): boolean {
  switch (part.type) {
    case "text-delta":
      return part.delta.trim().length > 0;
    case "file":
    case "source":
    case "custom":
    case "tool-approval-request":
    case "tool-call":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end":
    case "tool-result":
      return true;
    default:
      return false;
  }
}

function normalizeGeneratedContent(
  content: readonly LanguageModelV4Content[],
  finishReason: LanguageModelV4FinishReason,
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
      ...finalizeInlineReasoning(state, finishReason),
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
  assertGeneratedOutputHasDeliverable(normalized);
  return normalized;
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
): boolean {
  let hasDeliverableText = false;
  for (const event of events) {
    if (event.type === "text") {
      ensureTextStarted(controller, source.id, delayedTextStarts, startedTextIds);
      hasDeliverableText = event.text.trim().length > 0 || hasDeliverableText;
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
    const id = `${source.id}${INLINE_REASONING_ID_SEPARATOR}${event.sequence}`;
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
  return hasDeliverableText;
}

function finishTextState(
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  id: string,
  pendingTextEnds: Map<string, Extract<LanguageModelV4StreamPart, { type: "text-end" }>>,
  delayedTextStarts: Map<string, Extract<LanguageModelV4StreamPart, { type: "text-start" }>>,
  startedTextIds: Set<string>,
): void {
  ensureTextStarted(controller, id, delayedTextStarts, startedTextIds);
  controller.enqueue(pendingTextEnds.get(id) ?? { id, type: "text-end" });
  delayedTextStarts.delete(id);
  startedTextIds.delete(id);
  pendingTextEnds.delete(id);
}

export function createMiniMaxInlineReasoningMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      return { ...result, content: normalizeGeneratedContent(result.content, result.finishReason) };
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      const delayedTextStarts = new Map<
        string,
        Extract<LanguageModelV4StreamPart, { type: "text-start" }>
      >();
      const pendingTextEnds = new Map<
        string,
        Extract<LanguageModelV4StreamPart, { type: "text-end" }>
      >();
      const startedTextIds = new Set<string>();
      const states = new Map<string, InlineReasoningState>();
      let hasDeliverableOutput = false;

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
                hasDeliverableOutput = enqueueStreamEvents(
                  controller,
                  part,
                  consumeInlineReasoning(state, part.delta, false),
                  delayedTextStarts,
                  startedTextIds,
                ) || hasDeliverableOutput;
                return;
              }
              if (part.type === "text-end") {
                const state = states.get(part.id);
                if (state) {
                  hasDeliverableOutput = enqueueStreamEvents(
                    controller,
                    part,
                    consumeInlineReasoning(state, "", true),
                    delayedTextStarts,
                    startedTextIds,
                  ) || hasDeliverableOutput;
                  if (state.mode === "reasoning") {
                    pendingTextEnds.set(part.id, part);
                    return;
                  }
                  states.delete(part.id);
                }
                finishTextState(controller, part.id, pendingTextEnds, delayedTextStarts, startedTextIds);
                return;
              }
              if (part.type === "finish") {
                // Some compatible providers omit text-end; finish is the only boundary with reason.
                for (const [id, state] of states) {
                  hasDeliverableOutput = enqueueStreamEvents(
                    controller,
                    { delta: "", id, type: "text-delta" },
                    finalizeInlineReasoning(state, part.finishReason),
                    delayedTextStarts,
                    startedTextIds,
                  ) || hasDeliverableOutput;
                  finishTextState(controller, id, pendingTextEnds, delayedTextStarts, startedTextIds);
                }
                states.clear();
                if (!hasDeliverableOutput) throw emptyVisibleAnswerError();
              }
              hasDeliverableOutput = isStreamDeliverable(part) || hasDeliverableOutput;
              controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}
