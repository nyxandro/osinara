import { describe, expect, it, vi } from "vitest";
import { wrapLanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
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
