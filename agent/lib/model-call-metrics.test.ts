import { describe, expect, it, vi } from "vitest";
import { wrapLanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { errors as undiciErrors } from "undici";
import { createModelCallMetrics } from "./model-call-metrics.js";

describe("model request measurements", () => {
  it.each(["partial", "absent", "complete"] as const)("does not invent Anthropic stream totals (%s usage)", async kind => {
    const log = vi.fn();
    const chunks: unknown[] = kind === "absent" ? [] : [{ type: "message_start", message: {
      id: "test", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
    } }];
    if (kind === "complete") chunks.push({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    chunks.push({ type: "message_stop" });
    const provider = createAnthropic({ apiKey: "test", fetch: async () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) });
    const model = wrapLanguageModel({ model: provider("claude-sonnet-4-5"), middleware: createModelCallMetrics({
      provider: "anthropic", protocol: "anthropic-messages", modelId: "test", log,
    }) });
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] });
    for await (const _part of result.stream) {}
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ usageAvailable: kind === "complete", inputTokens: kind === "absent" ? null : 10, outputTokens: kind === "complete" ? 2 : null }));
  });

  it.each([false, true])("preserves Anthropic cache counter presence (reported: %s)", async (reported) => {
    const log = vi.fn();
    const provider = createAnthropic({ apiKey: "test", fetch: async () => new Response(JSON.stringify({
      id: "test", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2,
        ...(reported ? { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : {}),
      },
    }), { headers: { "content-type": "application/json" } }) });
    const model = wrapLanguageModel({ model: provider("claude-sonnet-4-5"), middleware: createModelCallMetrics({
      provider: "anthropic", protocol: "anthropic-messages", modelId: "test", log,
    }) });
    await model.doGenerate({ prompt: [{ role: "system", content: "stable-system" }, { role: "user", content: [{ type: "text", text: "test" }] }] });
    expect(log.mock.calls[0]![0].systemCharacters).toBeGreaterThan("stable-system".length);
    expect(JSON.stringify(log.mock.calls)).not.toContain("stable-system");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ usageAvailable: true,
      cacheReadTokens: reported ? 0 : null, cacheWriteTokens: reported ? 0 : null,
    }));
  });

  it("requests and records real cache usage without logging prompts or secrets", async () => {
    const records: Record<string, unknown>[] = [];
    const requestBodies: Record<string, unknown>[] = [];
    const provider = createOpenAICompatible({ name: "neuraldeep", baseURL: "https://test.invalid/v1", apiKey: "never-log-secret", includeUsage: true,
      fetch: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response([
          { id: "completion", created: 1, model: "test", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
          { id: "completion", created: 1, model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1024 } } },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    const model = wrapLanguageModel({ model: provider.chatModel("test"), middleware: createModelCallMetrics({ provider: "neuraldeep", protocol: "openai-chat-completions", modelId: "test", log: (record) => records.push(record) }) });
    const options = { prompt: [{ role: "system" as const, content: "private-content ".repeat(300) }, { role: "user" as const, content: [{ type: "text" as const, text: "question" }] }], providerOptions: { neuraldeep: { user: "opaque-session" } } };
    for (let index = 0; index < 2; index += 1) {
      const result = await model.doStream(options);
      for await (const _part of result.stream) { /* Consume the actual adapter output. */ }
    }
    expect(requestBodies[0]).toHaveProperty("stream_options.include_usage", true);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ usageAvailable: true, inputTokens: 1200, outputTokens: 2, cacheReadTokens: 1024, toolsUnchanged: true, systemUnchanged: true });
    expect(records[1]!.sharedMessagePrefixCharactersLowerBound).toBeGreaterThan(1024);
    expect(JSON.stringify(records)).not.toMatch(/private-content|never-log-secret|opaque-session|question/);
  });

  // A call its turn cancelled is not the model failing: OsinaraModelCallsFailing counts "failed" (#492).
  it.each([
    ["the turn cancelled it", true, "cancelled"],
    ["the call itself failed", false, "failed"],
  ])("records a generate call that threw as %s", async (_case, aborted, outcome) => {
    const log = vi.fn();
    const controller = new AbortController();
    if (aborted) controller.abort();
    const middleware = createModelCallMetrics({ provider: "test", protocol: "openai-chat-completions", modelId: "test", log });

    await expect(middleware.wrapGenerate!({
      doGenerate: async () => { throw new Error("stopped"); },
      params: { abortSignal: controller.signal },
    } as never)).rejects.toThrow("stopped");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome, usageAvailable: false }));
    if (aborted) expect(log.mock.calls[0]![0]).not.toHaveProperty("errorName");
    else expect(log.mock.calls[0]![0]).toMatchObject({ errorName: "Error", errorMessage: "stopped" });
  });

  // A failed call names what broke (#573): on 24.11.2026 the cause of 19 failures had to be pieced
  // together from the proxy's journal, because the record said only "failed".
  describe("names the failure of a failed call", () => {
    const socketError = () => Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });
    const streamingModel = (fetch: (input: unknown, init?: RequestInit) => Promise<Response>, log: (record: Record<string, unknown>) => void) =>
      wrapLanguageModel({
        model: createOpenAICompatible({ name: "neuraldeep", baseURL: "https://test.invalid/v1", apiKey: "never-log-secret", includeUsage: true, fetch: fetch as never }).chatModel("test"),
        middleware: createModelCallMetrics({ provider: "neuraldeep", protocol: "openai-chat-completions", modelId: "test", log }),
      });
    const options = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "private-question" }] }] };

    it("when the connection breaks before any answer", async () => {
      const records: Record<string, unknown>[] = [];
      const model = streamingModel(async () => { throw new TypeError("fetch failed", { cause: socketError() }); }, (record) => records.push(record));

      await expect(model.doStream(options)).rejects.toThrow("other side closed");
      expect(records).toEqual([expect.objectContaining({
        outcome: "failed", errorName: "AI_APICallError", errorMessage: "Cannot connect to API: other side closed",
        causeName: "SocketError", causeCode: "UND_ERR_SOCKET",
      })]);
      expect(JSON.stringify(records)).not.toMatch(/private-question|never-log-secret/);
    });

    it("when the provider answers with an error status", async () => {
      const records: Record<string, unknown>[] = [];
      const model = streamingModel(async () => new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
        status: 502, headers: { "content-type": "application/json" },
      }), (record) => records.push(record));

      await expect(model.doStream(options)).rejects.toThrow();
      expect(records).toEqual([expect.objectContaining({ outcome: "failed", errorName: "AI_APICallError", statusCode: 502 })]);
    });

    it("when the answer is cut off mid-stream", async () => {
      const records: Record<string, unknown>[] = [];
      const model = streamingModel(async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "c", created: 1, model: "test", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] })}\n\n`));
          controller.error(new TypeError("terminated", { cause: socketError() }));
        },
      }), { headers: { "content-type": "text/event-stream" } }), (record) => records.push(record));

      const result = await model.doStream(options);
      await expect((async () => { for await (const _part of result.stream) { /* Read until the break. */ } })()).rejects.toThrow("terminated");
      expect(records).toEqual([expect.objectContaining({
        outcome: "failed", errorName: "TypeError", errorMessage: "terminated", causeName: "SocketError", causeCode: "UND_ERR_SOCKET",
      })]);
    });

    it("when the provider reports an error inside the stream", async () => {
      const records: Record<string, unknown>[] = [];
      const model = streamingModel(async () => new Response(
        `data: ${JSON.stringify({ error: { message: "model overloaded", type: "server_error", code: 400 } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ), (record) => records.push(record));

      const result = await model.doStream(options);
      for await (const _part of result.stream) { /* The error arrives as a stream part. */ }
      expect(records).toEqual([expect.objectContaining({ outcome: "failed", errorName: "server_error", errorMessage: "model overloaded", errorCode: "400" })]);
    });

    // undici turns a refused CONNECT into "Request was cancelled."; the proxy's answer is two causes down.
    it("when the model proxy refuses the tunnel", async () => {
      const records: Record<string, unknown>[] = [];
      const refused = new undiciErrors.RequestAbortedError("Proxy response (502) !== 200 when HTTP Tunneling");
      const model = streamingModel(async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new DOMException("Request was cancelled."), { cause: refused }) });
      }, (record) => records.push(record));

      await expect(model.doStream(options)).rejects.toThrow();
      expect(records).toEqual([expect.objectContaining({
        outcome: "failed", causeCode: "UND_ERR_ABORTED", causeMessage: "Proxy response (502) !== 200 when HTTP Tunneling",
      })]);
    });

    it("without the model's text when its answer does not parse", async () => {
      const records: Record<string, unknown>[] = [];
      const model = streamingModel(async () => new Response(
        `data: ${JSON.stringify({ id: "c", choices: "private-reasoning private-answer" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ), (record) => records.push(record));

      const result = await model.doStream(options);
      for await (const _part of result.stream) { /* The unparsable chunk arrives as an error part. */ }
      expect(records).toEqual([expect.objectContaining({ outcome: "failed", errorName: "AI_TypeValidationError" })]);
      expect(JSON.stringify(records)).not.toContain("private-");
    });

    it("without a credential the provider echoes back", async () => {
      const records: Record<string, unknown>[] = [];
      const key = "sk-live-0123456789abcdefABCDEF0123456789";
      const model = streamingModel(async () => new Response(JSON.stringify({ error: { message: `Invalid API key: ${key}` } }), {
        status: 401, headers: { "content-type": "application/json" },
      }), (record) => records.push(record));

      await expect(model.doStream(options)).rejects.toThrow();
      expect(records).toEqual([expect.objectContaining({ outcome: "failed", statusCode: 401, errorMessage: expect.stringContaining("Invalid API key") })]);
      expect(JSON.stringify(records)).not.toContain(key);
    });

    it("with the code, name and message of one and the same cause", async () => {
      const records: Record<string, unknown>[] = [];
      const coded = Object.assign(new Error("upstream reset", { cause: new Error("plain detail") }), { name: "UpstreamError", code: "EUPSTREAM" });
      const model = streamingModel(async () => { throw new TypeError("fetch failed", { cause: coded }); }, (record) => records.push(record));

      await expect(model.doStream(options)).rejects.toThrow();
      expect(records).toEqual([expect.objectContaining({ causeCode: "EUPSTREAM", causeName: "UpstreamError", causeMessage: "upstream reset" })]);
    });

    it("but not of a cancelled call whose stream then reports an error", async () => {
      const log = vi.fn();
      const controller = new AbortController();
      const middleware = createModelCallMetrics({ provider: "test", protocol: "openai-chat-completions", modelId: "test", log });
      const result = await middleware.wrapStream!({
        doStream: async () => ({ stream: new ReadableStream({ start(stream) {
          controller.abort();
          stream.enqueue({ type: "error", error: new Error("stream closed after abort") });
          stream.close();
        } }) }),
        params: { abortSignal: controller.signal },
      } as never);

      for await (const _part of result.stream) { /* The error part follows the abort. */ }
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatchObject({ outcome: "cancelled" });
      expect(log.mock.calls[0]![0]).not.toHaveProperty("errorName");
    });

    it("but not of a call the turn cancelled mid-stream", async () => {
      const log = vi.fn();
      const controller = new AbortController();
      const middleware = createModelCallMetrics({ provider: "test", protocol: "openai-chat-completions", modelId: "test", log });
      const result = await middleware.wrapStream!({
        doStream: async () => ({ stream: new ReadableStream({ pull() { controller.abort(); throw new Error("aborted"); } }) }),
        params: { abortSignal: controller.signal },
      } as never);

      await expect((async () => { for await (const _part of result.stream) { /* Read until the abort. */ } })()).rejects.toThrow("aborted");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatchObject({ outcome: "cancelled" });
      expect(log.mock.calls[0]![0]).not.toHaveProperty("errorName");
    });

    it("keeps a long message short and names an application error by its code", async () => {
      const log = vi.fn();
      const middleware = createModelCallMetrics({ provider: "test", protocol: "openai-chat-completions", modelId: "test", log });
      const appError = Object.assign(new Error("x".repeat(1000)), { name: "AppError", code: "AGENT_MODEL_API_KEY_INVALID" });

      await expect(middleware.wrapGenerate!({ doGenerate: async () => { throw appError; }, params: {} } as never)).rejects.toBe(appError);
      const record = log.mock.calls[0]![0] as Record<string, unknown>;
      expect(record).toMatchObject({ outcome: "failed", errorName: "AppError", errorCode: "AGENT_MODEL_API_KEY_INVALID" });
      expect(String(record.errorMessage).length).toBeLessThanOrEqual(200);
    });
  });

  it("records missing usage as unknown rather than a zero-token success", async () => {
    const log = vi.fn();
    const middleware = createModelCallMetrics({ provider: "test", protocol: "openai-chat-completions", modelId: "test", log });
    await middleware.wrapGenerate!({ doGenerate: async () => ({
      content: [], finishReason: { unified: "stop" }, usage: { inputTokens: {}, outputTokens: {} },
    }) } as never);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ usageAvailable: false, inputTokens: null, outputTokens: null, cacheReadTokens: null }));
  });

  it.each([
    { usage: {}, expected: { usageAvailable: false, inputTokens: null, outputTokens: null, cacheReadTokens: null, reasoningTokens: null } },
    { usage: { prompt_tokens: 10 }, expected: { usageAvailable: false, inputTokens: 10, outputTokens: null, cacheReadTokens: null, reasoningTokens: null } },
    { usage: { prompt_tokens: 10, completion_tokens: 2 }, expected: { usageAvailable: true, inputTokens: 10, outputTokens: 2, cacheReadTokens: null, reasoningTokens: null } },
    { usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
      expected: { usageAvailable: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } },
  ])("distinguishes provider-reported zero from absent counters: $usage", async ({ usage, expected }) => {
    const log = vi.fn();
    const provider = createOpenAICompatible({ name: "test", baseURL: "https://test.invalid/v1", apiKey: "test", includeUsage: true,
      fetch: async () => new Response(`data: ${JSON.stringify({ id: "test", created: 1, model: "test", usage,
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }),
    });
    const model = wrapLanguageModel({ model: provider.chatModel("test"), middleware: createModelCallMetrics({
      provider: "test", protocol: "openai-chat-completions", modelId: "test", log,
    }) });
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] });
    for await (const _part of result.stream) { /* Consume the native adapter's normalized and raw usage. */ }
    expect(log).toHaveBeenCalledWith(expect.objectContaining(expected));
  });
});
