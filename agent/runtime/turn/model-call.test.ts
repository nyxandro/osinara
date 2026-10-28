import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, InvalidToolInputError, NoSuchToolError, RetryError, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createConfiguredLanguageModel } from "../../lib/model-transport.js";
import { callStepModel, EMPTY_RESPONSE_NUDGE, REASONING_EXHAUSTED_NUDGE, type StepModelCall } from "./model-call.js";

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

// One Chat Completions stream chunk, as an OpenAI-compatible provider sends it.
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason, index: 0 }], created: 1, id: "c", model: "m", object: "chat.completion.chunk" })}\n\n`;
}

// The application's own transport over a scripted provider: one response body per request.
function configuredModel(bodies: readonly string[]) {
  const requests: string[] = [];
  const configured = createConfiguredLanguageModel({
    apiKey: "model-secret",
    fetch: async (_url, init) => {
      requests.push(String(init?.body));
      return new Response(bodies[Math.min(requests.length, bodies.length) - 1], { headers: { "content-type": "text/event-stream" }, status: 200 });
    },
    maxOutputTokens: 16_384,
    modelId: "qwen3.8-27b",
    transport: { baseUrl: "https://provider.test/v1", protocol: "openai-chat-completions", providerName: "neuraldeep", reasoning: null },
  });
  return { model: configured, requests };
}

function call(provider: LanguageModel, overrides: Partial<StepModelCall> = {}): StepModelCall {
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

  it("hands over a call refused by its schema with the input the model sent and the reason", async () => {
    const provider = model(async () => ({ stream: streamOf([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: '{"command":7,"extra":true}' },
      { type: "tool-call", toolCallId: "c2", toolName: "fax", input: '{"to":"1"}' },
      FINISH("tool-calls"),
    ]) }));
    const tools = { bash: tool({ description: "bash", inputSchema: z.object({ command: z.string() }).strict() }) };

    const response = await callStepModel(call(provider, { tools }), NO_WAIT);

    expect(response.toolCalls).toMatchObject([
      { input: { command: 7, extra: true }, toolCallId: "c1", toolName: "bash" },
      { input: { to: "1" }, toolCallId: "c2", toolName: "fax" },
    ]);
    expect(InvalidToolInputError.isInstance(response.toolCalls[0]!.refused?.error)).toBe(true);
    expect(NoSuchToolError.isInstance(response.toolCalls[1]!.refused?.error)).toBe(true);
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

  it("returns a final answer the application refuses to the model once, with its own text and the notice", async () => {
    const provider = model(
      async () => ({ stream: streamOf(textParts("Вот: ![](/workspace/personal/gone.jpg)")) }),
      async () => ({ stream: streamOf(textParts("Исправленный ответ")) }),
    );
    const checkAnswer = async (text: string) => text.includes("gone.jpg") ? "notice: gone.jpg is missing" : undefined;
    const checks: string[] = [];

    const response = await callStepModel(call(provider, { checkAnswer: async (text) => { checks.push(text); return await checkAnswer(text); } }), NO_WAIT);

    expect(response.text).toBe("Исправленный ответ");
    expect(checks).toEqual(["Вот: ![](/workspace/personal/gone.jpg)"]);
    expect(provider.doStreamCalls[1]!.prompt.slice(-2)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Вот: ![](/workspace/personal/gone.jpg)" }] },
      { role: "user", content: [{ type: "text", text: "notice: gone.jpg is missing" }] },
    ]);
    expect(response.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "Исправленный ответ" }] }]);
  });

  it("keeps the refused answer when its correction fails", async () => {
    const provider = model(
      async () => ({ stream: streamOf(textParts("Вот: ![](/workspace/personal/gone.jpg)")) }),
      async () => ({ stream: streamOf(textParts("")) }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await callStepModel(call(provider, { checkAnswer: async () => "notice" }), NO_WAIT);

    expect(response.text).toBe("Вот: ![](/workspace/personal/gone.jpg)");
    expect(logged.mock.calls.map(([line]) => String(line)).join("\n")).toContain("AGENT_ANSWER_CHECK_CORRECTION_FAILED");
    logged.mockRestore();
  });

  it("does not check a step that calls tools or an answer that already used its reissue", async () => {
    const checkAnswer = vi.fn(async () => "notice");
    const toolStep = model(async () => ({ stream: streamOf([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: '{"command":"ls"}' },
      FINISH("tool-calls"),
    ]) }));
    const tools = { bash: tool({ description: "bash", inputSchema: z.object({ command: z.string() }) }) };
    await callStepModel(call(toolStep, { checkAnswer, tools }), NO_WAIT);

    const reissued = model(async () => ({ stream: streamOf(textParts("")) }), async () => ({ stream: streamOf(textParts("ответ")) }));
    expect((await callStepModel(call(reissued, { checkAnswer }), NO_WAIT)).text).toBe("ответ");

    expect(checkAnswer).not.toHaveBeenCalled();
  });

  it("names a failing answer check as the application's failure, never the model's", async () => {
    const provider = model(async () => ({ stream: streamOf(textParts("ответ")) }));
    const outage = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

    await expect(callStepModel(call(provider, { checkAnswer: async () => { throw outage; } }), NO_WAIT))
      .rejects.toMatchObject({ cause: outage, code: "AGENT_ANSWER_CHECK_FAILED" });
  });

  it("does not keep a refused answer when the person cancelled the turn meanwhile", async () => {
    const controller = new AbortController();
    const provider = model(async () => ({ stream: streamOf(textParts("ответ")) }));

    await expect(callStepModel(call(provider, {
      abortSignal: controller.signal,
      checkAnswer: async () => { controller.abort(); return "notice"; },
    }), NO_WAIT)).rejects.toMatchObject({ name: "TurnCancelledError" });
  });

  it("fails as recoverable when the reissued answer is empty again", async () => {
    const provider = model(async () => ({ stream: streamOf(textParts("  ")) }));

    await expect(callStepModel(call(provider), NO_WAIT)).rejects.toMatchObject({ name: "EmptyModelResponseError" });
    expect(provider.doStreamCalls).toHaveLength(2);
  });

  // #384: on 19.10 the model reasoned for ten minutes and spent all 16,384 output tokens before a word.
  const REASONING_ONLY = chunk({ reasoning_content: "думаю и думаю" }) + chunk({}, "length") + "data: [DONE]\n\n";
  const ANSWER = chunk({ content: "ответ" }) + chunk({}, "stop") + "data: [DONE]\n\n";

  it("reissues once with a notice a call that spent its whole output limit on reasoning", async () => {
    const provider = configuredModel([REASONING_ONLY, ANSWER]);

    const response = await callStepModel(call(provider.model), NO_WAIT);

    expect(response.text).toBe("ответ");
    expect(provider.requests).toHaveLength(2);
    expect(JSON.parse(provider.requests[1]!).messages.at(-1)).toEqual({ role: "user", content: REASONING_EXHAUSTED_NUDGE });
  });

  it("gives up after one reissue that spends its limit on reasoning again", async () => {
    const provider = configuredModel([REASONING_ONLY]);

    await expect(callStepModel(call(provider.model), NO_WAIT)).rejects.toMatchObject({ code: "AGENT_MODEL_REASONING_EXHAUSTED" });
    expect(provider.requests).toHaveLength(2);
  });

  it("does not reissue an answer cut at the length limit", async () => {
    const provider = configuredModel([chunk({ content: "длинный ответ" }) + chunk({}, "length") + "data: [DONE]\n\n", ANSWER]);

    await expect(callStepModel(call(provider.model), NO_WAIT)).rejects.toMatchObject({ code: "AGENT_MODEL_OUTPUT_TRUNCATED" });
    expect(provider.requests).toHaveLength(1);
  });

  it("repeats a call whose connection the provider closed in the middle of the answer", async () => {
    // #385: undici ends such a body with TypeError "terminated", which has no status and no retry flag.
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests > 1) {
        response.end(chunk({ content: "ответ" }) + chunk({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      response.write(chunk({ reasoning_content: "думаю" }));
      setTimeout(() => response.socket?.destroy(), 20);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const { port } = server.address() as AddressInfo;
      const provider = createOpenAICompatible({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, name: "neuraldeep" });

      const response = await callStepModel(call(provider("qwen3.8-27b"), { inactivity: { firstOutputMs: 5_000, gapMs: 5_000 } }), NO_WAIT);

      expect(response.text).toBe("ответ");
      expect(requests).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
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
