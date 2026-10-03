/**
 * NeuralDeep OpenAI-compatible transport contract tests.
 *
 * Constructs covered:
 * - `createConfiguredLanguageModel`: targets NeuralDeep's exact chat-completions endpoint.
 * - NeuralDeep receives Bearer authentication, session-sticky routing, and the audited output limit.
 * - Undocumented provider-specific reasoning controls are omitted from request payloads.
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { createConfiguredLanguageModel } from "./model-transport.js";
import { formatTurnMemoryContext } from "./prompt/turn-memory-context.js";

describe("NeuralDeep model transport", () => {
  it("projects turn memory into the tail so the system prefix repeats byte for byte", async () => {
    const requests: { messages: { role: string; content: string }[]; user: string; stream_options: unknown }[] = [];
    const model = createConfiguredLanguageModel({
      apiKey: "synthetic-secret", maxOutputTokens: 128, modelId: "qwen3.8-27b",
      transport: { baseUrl: "https://test.invalid/v1", protocol: "openai-chat-completions", providerName: "neuraldeep", reasoning: null },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response([
          { id: "test", created: 1, model: "qwen3.8-27b", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
          { id: "test", created: 1, model: "qwen3.8-27b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { id: "test", created: 1, model: "qwen3.8-27b", choices: [], usage: { prompt_tokens: 1200, completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 18 } } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    for (const question of ["first question", "second question"]) {
      const prompt: LanguageModelV4CallOptions["prompt"] = [
        { role: "system", content: `Stable rules\n\n${formatTurnMemoryContext(`Facts for ${question}`)}` },
        { role: "user", content: [{ type: "text", text: "Earlier question" }] },
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
        { role: "user", content: [{ type: "text", text: question }] },
      ];
      const original = structuredClone(prompt);
      const result = await model.doStream({ prompt, providerOptions: { neuraldeep: { user: "synthetic-session" } } });
      let finish;
      for await (const part of result.stream) if (part.type === "finish") finish = part;
      expect(finish?.usage).toMatchObject({ inputTokens: { total: 1200, cacheRead: 1024 }, outputTokens: { total: 20, reasoning: 18 } });
      expect(prompt).toEqual(original);
    }
    // The whole point of the projection: everything before the turn tail repeats unchanged, so the
    // provider can reuse the prefix it already computed for the previous turn.
    expect(requests[0]!.messages.slice(0, 3)).toEqual(requests[1]!.messages.slice(0, 3));
    for (const [index, request] of requests.entries()) {
      const question = index === 0 ? "first question" : "second question";
      expect(request.user).toBe("synthetic-session");
      expect(request.stream_options).toEqual({ include_usage: true });
      expect(request.messages[0]!.role).toBe("system");
      expect(request.messages[0]!.content).toBe("Stable rules");
      expect(request.messages).toHaveLength(5);
      expect(request.messages[3]).toEqual({
        role: "user",
        content: expect.stringContaining(`Facts for ${question}`),
      });
      expect(request.messages[3]!.content).toContain("<osinara_turn_memory>");
      expect(request.messages.at(-1)).toEqual({ role: "user", content: question });
    }
  });

  it("does not turn an unavailable-memory notice into a new request after tool results", async () => {
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const model = createConfiguredLanguageModel({
      apiKey: "synthetic-secret", maxOutputTokens: 128, modelId: "test-model",
      transport: { baseUrl: "https://test.invalid/v1", protocol: "openai-chat-completions", providerName: "test", reasoning: null },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "test", created: 1, model: "test-model", choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Дайджест" } },
        ], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      },
    });
    const prompt: LanguageModelV4CallOptions["prompt"] = [
      // A service notice is a rule about behaviour, not retrieved data: it is never wrapped as a
      // memory payload and must stay in the system prefix instead of arriving as a new request.
      { role: "system", content: "AGENT_MEMORY_UNAVAILABLE: Память недоступна" },
      { role: "user", content: [{ type: "text", text: "Собери дайджест" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "search-1", toolName: "web_search", input: { query: "AI" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "search-1", toolName: "web_search", output: { type: "text", value: "Новости" } }] },
    ];
    for (let step = 0; step < 3; step++) await model.doGenerate({ prompt });
    for (const body of bodies) {
      expect(body.messages.map(message => message.role)).toEqual(["system", "user", "assistant", "tool"]);
      expect(body.messages[1]!.content).toBe("Собери дайджест");
    }
  });

  it("uses the standard chat-completions contract without invented reasoning controls", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "Готово.", role: "assistant" } }],
        created: 1,
        id: "neuraldeep-completion",
        model: "qwen3.8-27b",
        object: "chat.completion",
        usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
      }), { headers: { "content-type": "application/json" }, status: 200 });
    });
    const model = createConfiguredLanguageModel({
      apiKey: "neuraldeep-secret",
      fetch,
      maxOutputTokens: 16_384,
      modelId: "qwen3.8-27b",
      transport: {
        baseUrl: "https://api.neuraldeep.ru/v1",
        protocol: "openai-chat-completions",
        providerName: "neuraldeep",
        reasoning: null,
      },
    });

    await model.doGenerate({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
      providerOptions: { neuraldeep: { user: "session_01CACHE" } },
    } as LanguageModelV4CallOptions);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.neuraldeep.ru/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer neuraldeep-secret" }),
        method: "POST",
      }),
    );
    expect(body).toMatchObject({
      max_tokens: 16_384,
      model: "qwen3.8-27b",
      user: "session_01CACHE",
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });
});
