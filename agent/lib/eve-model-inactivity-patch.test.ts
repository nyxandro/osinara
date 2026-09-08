/** Exercise the installed Eve harness and real AI SDK timers, not a second model loop. */
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { afterEach, expect, it, vi } from "vitest";
import { createToolLoopHarness } from "../../node_modules/eve/dist/src/harness/tool-loop.js";
import { mockModel } from "eve/evals";
import { APICallError, jsonSchema } from "ai";

const QUIET_MS = 5 * 60 * 1000;
afterEach(() => vi.useRealTimers());

function fixture(beforeHeaders = false) {
  let stream!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  let signal!: AbortSignal;
  const cancellation = new AbortController();
  const doStream = vi.fn<LanguageModelV4["doStream"]>(async (options) => {
    if (!options.abortSignal) throw new Error("TEST_MODEL_ABORT_MISSING");
    signal = options.abortSignal;
    if (beforeHeaders) return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return { stream: new ReadableStream({ start(c) {
      stream = c;
      c.enqueue({ type: "stream-start", warnings: [] });
      c.enqueue({ type: "reasoning-start", id: "reasoning" });
      signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
    } }) };
  });
  const model: LanguageModelV4 = { specificationVersion: "v4", provider: "test", modelId: "inactivity",
    supportedUrls: {}, doGenerate: vi.fn(), doStream };
  const step = createToolLoopHarness({ mode: "conversation", tools: new Map(), abortSignal: cancellation.signal,
    resolveModel: async () => model, handleEvent: async () => {} });
  const running = step({ sessionId: "test-inactivity", continuationToken: "test",
    agent: { system: "Reply to the user", modelReference: { id: "test/inactivity", contextWindowTokens: 10000 }, tools: [] },
    history: [], compaction: { threshold: 9000, recentWindowSize: 10 },
  }, { message: "test" });
  return { running, doStream, cancellation, signal: () => signal,
    reasoning() { stream.enqueue({ type: "reasoning-delta", id: "reasoning", delta: "working" }); },
  };
}

it("aborts a silent provider through the native first-output timer", async () => {
  vi.useFakeTimers();
  const state = fixture();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(state.doStream).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(state.signal().aborted).toBe(true);
  } finally { state.cancellation.abort(); await state.running.catch((error) => { if (error.name !== "TurnCancelledError") throw error; }); }
});

it("also bounds the first-output wait before response headers arrive", async () => {
  vi.useFakeTimers();
  const state = fixture(true);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(state.doStream).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(state.signal().aborted).toBe(true);
  } finally { state.cancellation.abort(); await state.running.catch((error) => { if (error.name !== "TurnCancelledError") throw error; }); }
});

it.each([true, false])("retains inactivity protection after a native transport retry (headers pending: %s)", async (beforeHeaders) => {
  vi.useFakeTimers();
  const state = fixture(beforeHeaders);
  state.doStream.mockRejectedValueOnce(new APICallError({ message: "test rate limit", url: "https://provider.invalid",
    requestBodyValues: {}, statusCode: 429, isRetryable: true }));
  try {
    await vi.advanceTimersByTimeAsync(2001);
    expect(state.doStream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(state.signal().aborted).toBe(true);
  } finally { state.cancellation.abort(); await state.running.catch((error) => { if (error.name !== "TurnCancelledError") throw error; }); }
});

it("does not apply model silence timers to a long tool after the provider finishes", async () => {
  vi.useFakeTimers();
  let toolSignal: AbortSignal | undefined;
  let finished = false;
  const cancellation = new AbortController();
  const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;
  const model = mockModel(() => ({ toolCalls: [{ name: "slow_tool", input: {} }] }));
  const step = createToolLoopHarness({ mode: "conversation", abortSignal: cancellation.signal,
    resolveModel: async () => model, handleEvent: async () => {},
    tools: new Map([["slow_tool", { name: "slow_tool", description: "A bounded long operation", inputSchema: jsonSchema(inputSchema),
      async execute(_input, options) {
        toolSignal = options.abortSignal;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2 * QUIET_MS);
          toolSignal?.addEventListener("abort", () => { clearTimeout(timer); reject(toolSignal?.reason); }, { once: true });
        });
        finished = true;
        return "completed";
      },
    }]]),
  });
  const running = step({ sessionId: "test-long-tool", continuationToken: "test", history: [],
    agent: { system: "Use the tool", modelReference: { id: "test/tool", contextWindowTokens: 10000 },
      tools: [{ name: "slow_tool", description: "A bounded long operation", inputSchema }] },
    compaction: { threshold: 9000, recentWindowSize: 10 },
  }, { message: "test" });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(toolSignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(2 * QUIET_MS + 1);
    expect(toolSignal?.aborted).toBe(false);
    expect(finished).toBe(true);
  } finally { cancellation.abort(); await running.catch((error) => { if (error.name !== "TurnCancelledError") throw error; }); }
});

it("keeps receiving reasoning beyond fifteen minutes and stops only after a silent interval", async () => {
  vi.useFakeTimers();
  const state = fixture();
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 10; index++) {
      state.reasoning();
      await vi.advanceTimersByTimeAsync(QUIET_MS / 2);
      expect(state.signal().aborted).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(QUIET_MS + 1);
    expect(state.signal().aborted).toBe(true);
    expect(state.doStream).toHaveBeenCalledOnce();
  } finally { state.cancellation.abort(); await state.running.catch((error) => { if (error.name !== "TurnCancelledError") throw error; }); }
});
