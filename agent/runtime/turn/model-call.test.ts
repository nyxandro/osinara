import { APICallError, RetryError, tool } from "ai";
import { z } from "zod";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { callStepModel, EMPTY_RESPONSE_NUDGE, type StepModelCall } from "./model-call.js";

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const FINISH = (unified: "stop" | "tool-calls"): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { raw: undefined, unified }, usage: USAGE });
const FAST = { firstOutputMs: 60, gapMs: 60 };
const NO_WAIT = { sleep: async () => {}, random: () => 0 };

type Script = (options: LanguageModelV4CallOptions) => Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }>;

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, ...(text ? [{ type: "text-delta", id: "t", delta: text } as const] : []), { type: "text-end", id: "t" }, FINISH("stop")];
}

function streamOf(parts: readonly LanguageModelV4StreamPart[], delayMs = 0): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

// A provider that never answers until the request is aborted, like a hung connection.
function hangUntilAborted(options: LanguageModelV4CallOptions, prefix: readonly LanguageModelV4StreamPart[] = []) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of prefix) controller.enqueue(part);
      options.abortSignal?.addEventListener("abort", () => controller.error(options.abortSignal!.reason), { once: true });
    },
  });
}

function model(...scripts: Script[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const script = scripts[Math.min(index, scripts.length - 1)]!;
      index += 1;
      return await script(options);
    },
  });
}

function call(provider: MockLanguageModelV4, overrides: Partial<StepModelCall> = {}): StepModelCall {
  return {
    abortSignal: new AbortController().signal,
    inactivity: FAST,
    messages: [{ role: "user", content: "привет" }],
    model: provider,
    providerOptions: undefined,
    system: "Instructions (instructions)\nправила",
    toolChoice: undefined,
    tools: {},
    ...overrides,
  };
}

describe("step model call", () => {
  it("returns the assistant message and tool calls and sends the prepared request unchanged", async () => {
    const provider = model(async () => ({ stream: streamOf([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: '{"command":"ls"}' },
      FINISH("tool-calls"),
    ]) }));

    const tools = { bash: tool({ description: "bash", inputSchema: z.object({ command: z.string() }) }) };
    const response = await callStepModel(call(provider, { providerOptions: { neuraldeep: { user: "wrun_X" } }, toolChoice: "none", tools }), NO_WAIT);

    expect(response.toolCalls).toEqual([{ input: { command: "ls" }, toolCallId: "c1", toolName: "bash" }]);
    expect(response.finishReason).toBe("tool-calls");
    expect(response.messages).toEqual([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }] }]);
    const sent = provider.doStreamCalls[0]!;
    expect(sent.prompt[0]).toEqual({ role: "system", content: "Instructions (instructions)\nправила" });
    expect(sent.providerOptions).toEqual({ neuraldeep: { user: "wrun_X" } });
    expect(sent.toolChoice).toEqual({ type: "none" });
  });

  it("marks the cached prefix for a provider on the Anthropic protocol, the empty-answer reissue included", async () => {
    let calls = 0;
    const provider = new MockLanguageModelV4({
      provider: "anthropic.messages",
      doStream: async () => ({ stream: streamOf(textParts(calls++ === 0 ? "" : "ответ")) }),
    });
    const tools = {
      bash: tool({ description: "bash", inputSchema: z.object({ command: z.string() }) }),
      todo: tool({ description: "todo", inputSchema: z.object({}) }),
    };
    const messages = [
      { role: "user" as const, content: "раньше" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ответ" }] },
      { role: "user" as const, content: "привет" },
    ];

    await callStepModel(call(provider, { messages, tools }), NO_WAIT);

    const marker = { anthropic: { cacheControl: { type: "ephemeral" } }, bedrock: { cachePoint: { type: "default" } } };
    for (const sent of provider.doStreamCalls) {
      expect(sent.prompt[0]).toEqual({ role: "system", content: "Instructions (instructions)\nправила", providerOptions: marker });
      expect(sent.prompt.slice(1).map((message) => message.providerOptions)).toEqual(
        sent.prompt.length === 4 ? [undefined, marker, marker] : [undefined, marker, undefined, marker],
      );
      expect(sent.tools?.map((definition) => "providerOptions" in definition ? definition.providerOptions : undefined)).toEqual([undefined, marker]);
    }
    expect(provider.doStreamCalls).toHaveLength(2);
  });

  it("stops waiting for a provider that never starts answering, headers included", async () => {
    const provider = model(async (options) => await new Promise((_, reject) =>
      options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason), { once: true })));

    await expect(callStepModel(call(provider), NO_WAIT)).rejects.toMatchObject({ code: "AGENT_MODEL_FIRST_CHUNK_TIMEOUT" });
    expect(provider.doStreamCalls).toHaveLength(3);
  });

  it("stops a stream that goes silent after it started", async () => {
    const provider = model(async (options) => ({ stream: hangUntilAborted(options, [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "начал" },
    ]) }));

    await expect(callStepModel(call(provider), NO_WAIT)).rejects.toMatchObject({ code: "AGENT_MODEL_STREAM_TIMEOUT" });
  });

  it("lets a long reasoning run past both windows while it keeps producing output", async () => {
    const reasoning: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }, { type: "reasoning-start", id: "r" },
      ...Array.from({ length: 6 }, (_, index) => ({ type: "reasoning-delta", id: "r", delta: `шаг ${index} ` }) as const),
      { type: "reasoning-end", id: "r" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "готово" }, { type: "text-end", id: "t" }, FINISH("stop")];
    const provider = model(async () => ({ stream: streamOf(reasoning, 25) }));

    // Parts are 25 ms apart: output starts at 75 ms, gaps between outputs stay under 90 ms, the run lasts ~325 ms.
    const response = await callStepModel(call(provider, { inactivity: { firstOutputMs: 100, gapMs: 90 } }), NO_WAIT);

    expect(response.text).toBe("готово");
    expect(provider.doStreamCalls).toHaveLength(1);
  });

  it("does not repeat a call the person cancelled", async () => {
    const turn = new AbortController();
    const provider = model(async (options) => {
      setTimeout(() => turn.abort(), 5);
      return { stream: hangUntilAborted(options, [{ type: "stream-start", warnings: [] }]) };
    });

    await expect(callStepModel(call(provider, { abortSignal: turn.signal, inactivity: { firstOutputMs: 5_000, gapMs: 5_000 } }), NO_WAIT))
      .rejects.toMatchObject({ name: "TurnCancelledError" });
    expect(provider.doStreamCalls).toHaveLength(1);
  });

  it("reissues an empty answer once with a wire-only notice", async () => {
    const provider = model(async () => ({ stream: streamOf(textParts("")) }), async () => ({ stream: streamOf(textParts("ответ")) }));

    const response = await callStepModel(call(provider), NO_WAIT);

    expect(response.text).toBe("ответ");
    expect(provider.doStreamCalls).toHaveLength(2);
    expect(provider.doStreamCalls[1]!.prompt.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: EMPTY_RESPONSE_NUDGE }] });
    expect(response.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "ответ" }] }]);
  });

  it("fails as recoverable when the reissued answer is empty again", async () => {
    const provider = model(async () => ({ stream: streamOf(textParts("  ")) }));

    await expect(callStepModel(call(provider), NO_WAIT)).rejects.toMatchObject({ name: "EmptyModelResponseError" });
    expect(provider.doStreamCalls).toHaveLength(2);
  });

  it("retries a transient provider failure and succeeds", async () => {
    const provider = model(
      async () => { throw new APICallError({ message: "bad gateway", url: "u", requestBodyValues: {}, statusCode: 502, isRetryable: true }); },
      async () => ({ stream: streamOf(textParts("ответ")) }),
    );

    expect((await callStepModel(call(provider), NO_WAIT)).text).toBe("ответ");
  });

  it("does not retry a rejected request", async () => {
    const provider = model(async () => { throw new APICallError({ message: "bad request", url: "u", requestBodyValues: {}, statusCode: 400, isRetryable: false }); });

    await expect(callStepModel(call(provider), NO_WAIT)).rejects.toMatchObject({ statusCode: 400 });
    expect(provider.doStreamCalls).toHaveLength(1);
  });

  it("does not multiply AI SDK's exhausted transport retries", async () => {
    const lastError = new APICallError({ message: "unavailable", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true });
    const provider = model(async () => { throw new RetryError({ message: "retries exhausted", reason: "maxRetriesExceeded", errors: [lastError] }); });

    await expect(callStepModel(call(provider), NO_WAIT)).rejects.toMatchObject({ code: "AGENT_MODEL_TEMPORARILY_UNAVAILABLE" });
    expect(provider.doStreamCalls).toHaveLength(1);
  });
});
