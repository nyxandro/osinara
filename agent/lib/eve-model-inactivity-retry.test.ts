/** Real Eve retry loop with native SDK timers; no provider or Telegram requests. */
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { afterEach, expect, it, vi } from "vitest";
import { createToolLoopHarness } from "../../node_modules/eve/dist/src/harness/tool-loop.js";
import { APICallError, jsonSchema } from "ai";
import { recoverableModelFailureCode } from "./model-failure.js";

const QUIET_MS = 300_000;
afterEach(() => vi.useRealTimers());

function start(mode: "task" | "conversation", beforeHeaders: boolean, succeedOn = Infinity) {
  const cancellation = new AbortController();
  const signals: AbortSignal[] = [];
  const events: Array<{ type: string; data?: any }> = [];
  const doStream = vi.fn<LanguageModelV4["doStream"]>(async options => {
    const signal = options.abortSignal!;
    signals.push(signal);
    if (signals.length >= succeedOn) return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "text" });
        controller.enqueue({ type: "text-delta", id: "text", delta: "Готово" });
        controller.enqueue({ type: "text-end", id: "text" });
        controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
        controller.close();
      } }),
    };
    if (beforeHeaders) return await new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    } }) };
  });
  const model: LanguageModelV4 = { specificationVersion: "v4", provider: "test", modelId: "inactivity",
    supportedUrls: {}, doGenerate: vi.fn(), doStream };
  const step = createToolLoopHarness({ mode, tools: new Map(), abortSignal: cancellation.signal,
    resolveModel: async () => model, handleEvent: async event => { events.push(event); } });
  const settled = step({ sessionId: "test-retry", continuationToken: "test-retry", history: [],
    agent: { system: "Reply", modelReference: { id: "test/inactivity", contextWindowTokens: 10000 }, tools: [] },
    compaction: { threshold: 9000, recentWindowSize: 10 },
  }, { message: "Проверка" }).then(result => ({ result, error: null }), error => ({ result: null, error }));
  return { cancellation, doStream, events, settled, signals };
}

it.each([true, false])("retries the first-output timeout three times in task mode (before headers: %s)", async beforeHeaders => {
  vi.useFakeTimers();
  const state = start("task", beforeHeaders);
  try {
    await vi.advanceTimersByTimeAsync(3 * (QUIET_MS + 2_000));
    expect(state.doStream).toHaveBeenCalledTimes(3);
    expect(state.signals.every(signal => signal.aborted)).toBe(true);
    const outcome = await state.settled;
    expect(outcome.error).toBeNull();
    expect(outcome.result?.next).toMatchObject({ done: true, isError: true });
    const failure = state.events.find(event => event.type === "turn.failed");
    expect(failure?.data.message).toContain("AGENT_MODEL_FIRST_CHUNK_TIMEOUT");
  } finally { state.cancellation.abort(); await state.settled; }
});

it.each(["task", "conversation"] as const)("uses a fresh timeout signal and succeeds after a timeout in %s mode", async mode => {
  vi.useFakeTimers();
  const state = start(mode, true, 2);
  try {
    await vi.advanceTimersByTimeAsync(QUIET_MS + 2_000);
    expect(state.doStream).toHaveBeenCalledTimes(2);
    expect(state.signals[1]?.aborted).toBe(false);
    expect((await state.settled).error).toBeNull();
    expect(state.events.some(event => event.type === "turn.completed")).toBe(true);
  } finally { state.cancellation.abort(); await state.settled; }
});

it("does not retry a user cancellation", async () => {
  vi.useFakeTimers();
  const state = start("task", true);
  await vi.advanceTimersByTimeAsync(0);
  state.cancellation.abort();
  await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
  await state.settled;
  expect(state.doStream).toHaveBeenCalledOnce();
});

it("keeps the existing bounded HTTP retries and exposes their final model failure", async () => {
  vi.useFakeTimers();
  const state = start("task", true);
  state.doStream.mockRejectedValue(new APICallError({ message: "Rate limited", statusCode: 429,
    url: "https://model.invalid", requestBodyValues: {}, isRetryable: true }));
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.doStream).toHaveBeenCalledTimes(3);
    expect((await state.settled).error).toBeNull();
    const failure = state.events.find(event => event.type === "turn.failed");
    expect(recoverableModelFailureCode(failure!.data)).toBe("AGENT_MODEL_TEMPORARILY_UNAVAILABLE");
  } finally { state.cancellation.abort(); await vi.advanceTimersByTimeAsync(2_000); await state.settled; }
});

it("classifies an interrupted response stream as an exhausted temporary model failure", async () => {
  vi.useFakeTimers();
  const state = start("task", true);
  state.doStream.mockImplementation(async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({ type: "text-start", id: "text" });
    controller.enqueue({ type: "text-delta", id: "text", delta: "Начало" });
    queueMicrotask(() => controller.error(new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    })));
  } }) }));
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.doStream).toHaveBeenCalledTimes(3);
    expect((await state.settled).error).toBeNull();
    const failure = state.events.find(event => event.type === "turn.failed");
    expect(failure?.data.details.semanticErrorId).toBe("network-request-failed");
    expect(recoverableModelFailureCode(failure!.data)).toBe("AGENT_MODEL_TEMPORARILY_UNAVAILABLE");
  } finally { state.cancellation.abort(); await vi.advanceTimersByTimeAsync(2_000); await state.settled; }
});

it("preserves an exhausted empty-response failure for model recovery", async () => {
  vi.useFakeTimers();
  const state = start("task", true);
  state.doStream.mockImplementation(async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.close();
  } }) }));
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.doStream).toHaveBeenCalledTimes(2);
    expect((await state.settled).error).toBeNull();
    const failure = state.events.find(event => event.type === "turn.failed");
    expect(recoverableModelFailureCode(failure!.data)).toBe("AGENT_MODEL_OUTPUT_INCOMPLETE");
  } finally { state.cancellation.abort(); await vi.advanceTimersByTimeAsync(2_000); await state.settled; }
});

it("does not repeat a completed tool when the following model call times out", async () => {
  vi.useFakeTimers();
  const cancellation = new AbortController();
  const write = vi.fn(async () => "saved");
  let calls = 0;
  const doStream = vi.fn<LanguageModelV4["doStream"]>(async options => ({
    stream: new ReadableStream({ start(controller) {
      calls += 1;
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (calls !== 1) {
        options.abortSignal!.addEventListener("abort", () => controller.error(options.abortSignal!.reason), { once: true });
        return;
      }
      controller.enqueue({ type: "tool-input-start", id: "save-1", toolName: "save" });
      controller.enqueue({ type: "tool-input-delta", id: "save-1", delta: "{}" });
      controller.enqueue({ type: "tool-input-end", id: "save-1" });
      controller.enqueue({ type: "tool-call", toolCallId: "save-1", toolName: "save", input: "{}" });
      controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
      controller.close();
    } }),
  }));
  const model: LanguageModelV4 = { specificationVersion: "v4", provider: "test", modelId: "write-timeout",
    supportedUrls: {}, doGenerate: vi.fn(), doStream };
  const schema = { type: "object", properties: {}, additionalProperties: false } as const;
  const step = createToolLoopHarness({ mode: "task", abortSignal: cancellation.signal,
    resolveModel: async () => model, handleEvent: async () => {},
    tools: new Map([["save", { name: "save", description: "Save", inputSchema: jsonSchema(schema), execute: write }]]),
  });
  const firstPromise = step({ sessionId: "tool-timeout", continuationToken: "tool-timeout", history: [],
    agent: { system: "Save", modelReference: { id: "test/write-timeout", contextWindowTokens: 10000 },
      tools: [{ name: "save", description: "Save", inputSchema: schema }] },
    compaction: { threshold: 9000, recentWindowSize: 10 },
  }, { message: "Save" });
  await vi.advanceTimersByTimeAsync(0);
  const first = await firstPromise;
  expect(write).toHaveBeenCalledOnce();
  if (typeof first.next !== "function") throw new Error("TEST_CONTINUATION_MISSING");
  const settled = first.next(first.session).then(result => ({ result, error: null }), error => ({ result: null, error }));
  try {
    await vi.advanceTimersByTimeAsync(QUIET_MS * 4);
    expect(doStream).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenCalledOnce();
    expect((await settled).result?.next).toMatchObject({ done: true, isError: true });
  } finally { cancellation.abort(); await vi.advanceTimersByTimeAsync(2_000); await settled; }
});
