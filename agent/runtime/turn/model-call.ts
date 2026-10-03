/**
 * One model step: a single streamed model call, its inactivity windows and its recovery.
 *
 * Exports:
 * - `MODEL_INACTIVITY_TIMEOUT`: five minutes to the first output, then at most five minutes between
 *   outputs. Long reasoning is fine while it keeps streaming.
 * - `callStepModel`: calls the model for one step and returns the assistant message and its tool
 *   calls; tool calls are executed afterwards by the turn, never inside the call.
 * - `EMPTY_RESPONSE_NUDGE`: the wire-only notice of the one reissue after an empty answer.
 * - `assistantStepText`: the visible text of a step's response.
 *
 * Recovery, in order:
 * - AI SDK's own transport retries cover a request that never got a response (its default, 2).
 * - A `retry`-class failure — a stream broken after it started, an inactivity window — repeats the
 *   call up to three attempts with exponential backoff. No side effect can repeat: tools run later.
 * - An empty answer is reissued once with `EMPTY_RESPONSE_NUDGE` appended to that request only.
 * On the Anthropic protocol every attempt carries prompt-cache breakpoints (`prompt-cache.ts`).
 *
 * Derived from eve 0.40.0 `harness/tool-loop.ts` (`runModelCallWithRetries`,
 * `attemptEmptyResponseRecovery`, `isEmptyModelResponse`), `harness/messages.ts`
 * (`resolveAssistantStepText`) and Osinara's `scripts/eve-runtime/model-inactivity.ts`
 * (Apache-2.0, see NOTICE-eve). Changes: the runtime owns both inactivity windows over the parts it
 * reads, so the first window also covers the wait for response headers (AI SDK 7.0.60 started it
 * after them) and no window runs while tools execute.
 */
import { NoOutputGeneratedError, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import {
  classifyModelCallError,
  EmptyModelResponseError,
  ModelInactivityError,
  normalizeModelCallError,
  TurnCancelledError,
} from "./model-errors.js";
import { markPromptCache, usesAnthropicPromptCache } from "./prompt-cache.js";

export const MODEL_INACTIVITY_TIMEOUT = Object.freeze({ firstOutputMs: 5 * 60 * 1000, gapMs: 5 * 60 * 1000 });
export const EMPTY_RESPONSE_NUDGE =
  "Your previous reply was empty and was not delivered. Answer now from the tool results above; do not re-run tools or mention this notice.";

const MODEL_CALL_MAX_ATTEMPTS = 3;
const MODEL_CALL_RETRY_BASE_DELAY_MS = 500;
const MODEL_CALL_RETRY_JITTER_MS = 250;
// Output that proves the model is generating; metadata and empty deltas do not.
const CONTENT_PART_TYPES = new Set(["text-delta", "reasoning-delta", "tool-input-delta", "tool-call", "file"]);

export interface StepModelCall {
  readonly abortSignal: AbortSignal;
  readonly inactivity: { readonly firstOutputMs: number; readonly gapMs: number };
  readonly messages: readonly ModelMessage[];
  readonly model: LanguageModel;
  readonly providerOptions: SharedV4ProviderOptions | undefined;
  readonly system: string;
  readonly toolChoice: "none" | undefined;
  readonly tools: ToolSet;
}

export interface StepToolCall {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface StepModelResponse {
  readonly finishReason: string;
  /** The assistant message as AI SDK built it, provider metadata included. */
  readonly messages: ModelMessage[];
  readonly text: string;
  readonly toolCalls: readonly StepToolCall[];
  readonly usage: unknown;
}

export interface ModelCallTiming {
  readonly random: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const REAL_TIMING: ModelCallTiming = {
  random: Math.random,
  sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
};

/** The step's visible text: the last assistant message that has any, as Eve resolved it. */
export function assistantStepText(messages: readonly ModelMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "text" ? part.text : "").join("");
    if (text.trim().length > 0) return text;
  }
  return "";
}

async function callOnce(input: StepModelCall, trailingUserNote: string | undefined): Promise<StepModelResponse> {
  if (input.abortSignal.aborted) throw new TurnCancelledError({ cause: input.abortSignal.reason });
  const watchdog = new AbortController();
  let timer = setTimeout(() => watchdog.abort(new ModelInactivityError("AGENT_MODEL_FIRST_CHUNK_TIMEOUT")), input.inactivity.firstOutputMs);
  const restartGap = () => {
    clearTimeout(timer);
    timer = setTimeout(() => watchdog.abort(new ModelInactivityError("AGENT_MODEL_STREAM_TIMEOUT")), input.inactivity.gapMs);
  };
  const failure = (error: unknown): unknown => {
    if (input.abortSignal.aborted) return new TurnCancelledError({ cause: input.abortSignal.reason });
    if (watchdog.signal.aborted) return watchdog.signal.reason;
    if (NoOutputGeneratedError.isInstance(error)) return new EmptyModelResponseError({ cause: error });
    return normalizeModelCallError(error);
  };
  try {
    const sent: ModelMessage[] = trailingUserNote === undefined
      ? [...input.messages]
      : [...input.messages, { role: "user", content: trailingUserNote }];
    const request = usesAnthropicPromptCache(input.model)
      ? markPromptCache({ messages: sent, system: input.system, tools: input.tools })
      : { messages: sent, system: input.system, tools: input.tools };
    const result = streamText({
      abortSignal: AbortSignal.any([input.abortSignal, watchdog.signal]),
      instructions: request.system,
      messages: request.messages,
      model: input.model,
      // Errors reach the turn through the stream; AI SDK's default would print them a second time.
      onError: () => {},
      providerOptions: input.providerOptions,
      toolChoice: input.toolChoice,
      tools: request.tools,
    });
    for await (const part of result.stream) {
      if (part.type === "error") throw part.error;
      if (part.type === "abort") throw watchdog.signal.reason ?? input.abortSignal.reason;
      const delta = "text" in part && typeof part.text === "string" ? part.text : "delta" in part ? part.delta : undefined;
      if (CONTENT_PART_TYPES.has(part.type) && (typeof delta !== "string" || delta.length > 0)) restartGap();
    }
    const [messages, toolCalls, finishReason, usage] = await Promise.all([
      result.responseMessages, result.toolCalls, result.finishReason, result.usage,
    ]);
    const text = assistantStepText(messages);
    if (toolCalls.length === 0 && text.length === 0) throw new EmptyModelResponseError();
    return {
      finishReason,
      messages: [...messages],
      text,
      toolCalls: toolCalls.map((call) => ({ input: call.input, toolCallId: call.toolCallId, toolName: call.toolName })),
      usage,
    };
  } catch (error) {
    throw failure(error);
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetries(input: StepModelCall, trailingUserNote: string | undefined, timing: ModelCallTiming) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await callOnce(input, trailingUserNote);
    } catch (error) {
      if (attempt === MODEL_CALL_MAX_ATTEMPTS || classifyModelCallError(error) !== "retry") throw error;
      await timing.sleep(MODEL_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(timing.random() * MODEL_CALL_RETRY_JITTER_MS));
      if (input.abortSignal.aborted) throw new TurnCancelledError({ cause: input.abortSignal.reason });
    }
  }
}

export async function callStepModel(input: StepModelCall, timing: ModelCallTiming = REAL_TIMING): Promise<StepModelResponse> {
  try {
    return await callWithRetries(input, undefined, timing);
  } catch (error) {
    if (!(error instanceof EmptyModelResponseError)) throw error;
    return await callWithRetries(input, EMPTY_RESPONSE_NUDGE, timing);
  }
}
