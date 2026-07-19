/**
 * MiniMax inline reasoning parser.
 *
 * Exports:
 * - `InlineReasoningEvent`: normalized text/reasoning parser events.
 * - `InlineReasoningState`: streamable parser state for chunked provider output.
 * - `createInlineReasoningState`: creates an isolated parser state.
 * - `consumeInlineReasoning`: consumes text chunks while keeping possible tag prefixes buffered.
 * - `finalizeInlineReasoning`: closes or rejects unfinished hidden reasoning by finish reason.
 * - `emptyVisibleAnswerError`: stable failure for hidden-only model output.
 */
import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";

import { AppError } from "./app-error.js";

const MINI_MAX_REASONING_TAGS = ["think", "mm:think", "thinking"] as const;
const MINI_MAX_REASONING_TRUNCATED_CODE = "AGENT_MINIMAX_REASONING_TRUNCATED";
const MINI_MAX_EMPTY_VISIBLE_ANSWER_CODE = "AGENT_MINIMAX_EMPTY_VISIBLE_ANSWER";

export type InlineReasoningEvent =
  | { readonly text: string; readonly type: "text" }
  | { readonly sequence: number; readonly type: "reasoning-start" }
  | { readonly sequence: number; readonly text: string; readonly type: "reasoning-delta" }
  | { readonly sequence: number; readonly type: "reasoning-end" };

interface InlineReasoningBoundary {
  closing: boolean;
  length: number;
  selfClosing: boolean;
}

export interface InlineReasoningState {
  buffer: string;
  mode: "text" | "reasoning";
  reasoningDepth: number;
  reasoningSequence: number;
}

function reasoningTruncatedError(): AppError {
  return new AppError(
    MINI_MAX_REASONING_TRUNCATED_CODE,
    "Модель оборвала скрытую часть ответа до завершения. Попробуйте повторить запрос или сократить сообщение",
  );
}

export function emptyVisibleAnswerError(): AppError {
  return new AppError(
    MINI_MAX_EMPTY_VISIBLE_ANSWER_CODE,
    "Модель не вернула готовый ответ. Попробуйте повторить запрос или переформулировать его",
  );
}

export function createInlineReasoningState(): InlineReasoningState {
  return {
    buffer: "",
    mode: "text",
    reasoningDepth: 0,
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
  boundary: InlineReasoningBoundary,
): void {
  if (boundary.selfClosing) return;

  // Bias-to-hidden: nested openings deepen the hidden block instead of failing the turn.
  if (!boundary.closing) {
    if (state.mode === "reasoning") {
      state.reasoningDepth += 1;
      return;
    }
    state.mode = "reasoning";
    state.reasoningDepth = 1;
    state.reasoningSequence += 1;
    events.push({ sequence: state.reasoningSequence, type: "reasoning-start" });
    return;
  }

  // MiniMax can send reasoning structurally while leaving its closing separator in content.
  if (state.mode === "text") return;
  state.reasoningDepth -= 1;
  if (state.reasoningDepth > 0) return;
  events.push({ sequence: state.reasoningSequence, type: "reasoning-end" });
  state.mode = "text";
  state.reasoningDepth = 0;
}

function finishReasonAllowsOpenReasoning(finishReason: LanguageModelV4FinishReason): boolean {
  return finishReason.unified === "stop" || finishReason.unified === "tool-calls";
}

function isReasoningTagSeparator(character: string | undefined): boolean {
  return character === undefined || character === ">" || character === "/" || /\s/u.test(character);
}

function completeReasoningBoundary(buffer: string): InlineReasoningBoundary | null {
  const normalized = buffer.toLowerCase();

  for (const tag of MINI_MAX_REASONING_TAGS) {
    const closingStart = `</${tag}`;
    if (normalized.startsWith(closingStart)) {
      const closingMatch = /^\s*>/u.exec(normalized.slice(closingStart.length));
      if (closingMatch) {
        return {
          closing: true,
          length: closingStart.length + closingMatch[0].length,
          selfClosing: false,
        };
      }
    }

    const openingStart = `<${tag}`;
    if (!normalized.startsWith(openingStart)) continue;
    if (!isReasoningTagSeparator(normalized[openingStart.length])) continue;

    const closingIndex = normalized.indexOf(">", openingStart.length);
    if (closingIndex === -1) continue;
    return {
      closing: false,
      length: closingIndex + 1,
      selfClosing: normalized.slice(openingStart.length, closingIndex).trimEnd().endsWith("/"),
    };
  }

  return null;
}

function couldBecomeReasoningBoundary(buffer: string): boolean {
  const normalized = buffer.toLowerCase();

  return MINI_MAX_REASONING_TAGS.some((tag) => {
    const openingStart = `<${tag}`;
    const closingStart = `</${tag}`;
    if (openingStart.startsWith(normalized) || closingStart.startsWith(normalized)) return true;

    if (normalized.startsWith(openingStart)) {
      return isReasoningTagSeparator(normalized[openingStart.length]) && !normalized.includes(">");
    }

    if (normalized.startsWith(closingStart)) {
      return isReasoningTagSeparator(normalized[closingStart.length]) && !normalized.includes(">");
    }

    return false;
  });
}

export function consumeInlineReasoning(
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
    const boundary = completeReasoningBoundary(state.buffer);
    if (boundary) {
      applyReasoningBoundary(state, events, boundary);
      state.buffer = state.buffer.slice(boundary.length);
      continue;
    }

    if (couldBecomeReasoningBoundary(normalized)) {
      if (!final) break;
      state.buffer = "";
      break;
    }

    emitInlineText(state, events, state.buffer[0]!);
    state.buffer = state.buffer.slice(1);
  }

  return events;
}

export function finalizeInlineReasoning(
  state: InlineReasoningState,
  finishReason: LanguageModelV4FinishReason,
): InlineReasoningEvent[] {
  const events = consumeInlineReasoning(state, "", true);
  if (state.mode !== "reasoning") return events;
  if (!finishReasonAllowsOpenReasoning(finishReason)) throw reasoningTruncatedError();

  events.push({ sequence: state.reasoningSequence, type: "reasoning-end" });
  state.mode = "text";
  state.reasoningDepth = 0;
  return events;
}
