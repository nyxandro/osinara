/**
 * Protocol-native model transport tests.
 *
 * Constructs covered:
 * - `createConfiguredLanguageModel`: selects an AI SDK adapter by wire protocol.
 * - Anthropic Messages requests enable adaptive thinking and use configured authentication.
 * - Streaming thinking signatures survive the assistant/tool-result round trip unchanged.
 * - Codex subscription requests carry the selected reasoning effort through Chat Completions.
 */
import { generateText, stepCountIs, streamText, tool } from "ai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createConfiguredLanguageModel } from "./model-transport.js";

const SIGNATURE = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function sse(events: readonly { readonly data: unknown; readonly event: string }[]): Response {
  return new Response(events.map(({ data, event }) => [
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
    "",
  ].join("\n")).join("\n"), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function messageStart(id: string) {
  return {
    data: {
      message: {
        content: [],
        id,
        model: "MiniMax-M3",
        role: "assistant",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 20, output_tokens: 0 },
      },
      type: "message_start",
    },
    event: "message_start",
  };
}

const thinkingEvents = [
  {
    data: { content_block: { thinking: "", type: "thinking" }, index: 0, type: "content_block_start" },
    event: "content_block_start",
  },
  {
    data: {
      delta: { thinking: "Нужно вызвать инструмент.", type: "thinking_delta" },
      index: 0,
      type: "content_block_delta",
    },
    event: "content_block_delta",
  },
  {
    data: {
      delta: { signature: SIGNATURE, type: "signature_delta" },
      index: 0,
      type: "content_block_delta",
    },
    event: "content_block_delta",
  },
  { data: { index: 0, type: "content_block_stop" }, event: "content_block_stop" },
] as const;

describe("createConfiguredLanguageModel", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("observes a real completed model response through an explicit success callback", async () => {
    const onSuccessfulCall = vi.fn();
    const model = createConfiguredLanguageModel({
      apiKey: "test", modelId: "health-test", maxOutputTokens: 100, onSuccessfulCall,
      transport: { protocol: "openai-chat-completions", providerName: "test", baseUrl: "https://model.invalid/v1" },
      fetch: async () => jsonResponse({ id: "health", created: 1, model: "health-test",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Готово" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    } as never);
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Проверка" }] }] });
    expect(onSuccessfulCall).toHaveBeenCalledOnce();
    expect(onSuccessfulCall).toHaveBeenCalledWith(expect.objectContaining({ routeKey: expect.any(String), observedAt: expect.any(Date) }));
  });

  it("fails before fetch instead of sending an unrelated environment credential", async () => {
    const fetch = vi.fn();
    vi.stubEnv("ANTHROPIC_API_KEY", "foreign-anthropic-key");
    const model = createConfiguredLanguageModel({
      apiKey: "",
      fetch,
      maxOutputTokens: 128_000,
      modelId: "MiniMax-M3",
      transport: {
        authentication: "bearer",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    await expect(model.doGenerate({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions)).rejects.toThrow("AGENT_MODEL_API_KEY_INVALID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("selects a generic OpenAI-compatible model strictly by protocol", async () => {
    let request: { body: Record<string, unknown>; headers: Headers; url: string } | undefined;
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async (input, init) => {
        request = {
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
          url: String(input),
        };
        return jsonResponse({
          choices: [{ finish_reason: "stop", index: 0, message: { content: "Готово", role: "assistant" } }],
          created: 1,
          id: "completion-1",
          model: "provider/model-name",
          object: "chat.completion",
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        });
      },
      maxOutputTokens: 32_000,
      modelId: "provider/model-name",
      transport: {
        baseUrl: "https://openrouter.ai/api/v1",
        protocol: "openai-chat-completions",
        providerName: "openrouter",
        reasoning: { effort: "high", format: "reasoning-object", type: "effort" },
      },
    });

    await expect(model.doGenerate({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions)).resolves.toMatchObject({
      content: [{ text: "Готово", type: "text" }],
    });
    expect(model.modelId).toBe("provider/model-name");
    expect(model.provider).toBe("openrouter.chat");
    expect(request).toMatchObject({
      body: {
        max_tokens: 32_000,
        model: "provider/model-name",
        reasoning: { effort: "high" },
      },
      url: "https://openrouter.ai/api/v1/chat/completions",
    });
    expect(request?.headers.get("authorization")).toBe("Bearer model-secret");
  });

  it("sends medium reasoning to the internal Codex subscription gateway", async () => {
    let request: { body: Record<string, unknown>; headers: Headers; url: string } | undefined;
    const model = createConfiguredLanguageModel({
      apiKey: "internal-proxy-secret",
      fetch: async (input, init) => {
        request = {
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
          url: String(input),
        };
        return jsonResponse({
          choices: [{ finish_reason: "stop", index: 0, message: { content: "Готово", role: "assistant" } }],
          created: 1,
          id: "completion-codex-1",
          model: "gpt-5.6-luna",
          object: "chat.completion",
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        });
      },
      maxOutputTokens: 128_000,
      modelId: "gpt-5.6-luna",
      transport: {
        baseUrl: "http://cli-proxy-api:8317/v1",
        protocol: "openai-chat-completions",
        providerName: "codex-subscription",
        reasoning: { effort: "medium", format: "reasoning-effort", type: "effort" },
      },
    });

    await model.doGenerate({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions);

    expect(request).toMatchObject({
      body: {
        max_tokens: 128_000,
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
      },
      url: "http://cli-proxy-api:8317/v1/chat/completions",
    });
    expect(request?.headers.get("authorization")).toBe("Bearer internal-proxy-secret");
  });

  it("uses x-api-key authentication when selected by Anthropic protocol config", async () => {
    let headers: Headers | undefined;
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return jsonResponse({
          content: [{ text: "Готово", type: "text" }],
          id: "msg_auth_001",
          model: "compatible-model",
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
      maxOutputTokens: 8_000,
      modelId: "compatible-model",
      transport: {
        authentication: "api-key",
        baseUrl: "https://example-provider.test/v1",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    await model.doGenerate({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions);

    expect(headers?.get("x-api-key")).toBe("model-secret");
    expect(headers?.get("authorization")).toBeNull();
  });

  it.each([
    ["max_tokens", "AGENT_MODEL_OUTPUT_TRUNCATED"],
    ["refusal", "AGENT_MODEL_OUTPUT_FILTERED"],
    ["unknown_stop", "AGENT_MODEL_OUTPUT_INCOMPLETE"],
  ])("rejects incomplete Anthropic output with stop reason %s", async (stopReason, code) => {
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async () => jsonResponse({
        content: [{ text: "Неполный ответ", type: "text" }],
        id: "msg_incomplete_001",
        model: "compatible-model",
        role: "assistant",
        stop_reason: stopReason,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      maxOutputTokens: 8_000,
      modelId: "compatible-model",
      transport: {
        authentication: "bearer",
        baseUrl: "https://example-provider.test/v1",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    await expect(model.doGenerate({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions)).rejects.toThrow(code);
  });

  it("rejects a truncated streaming response before its finish event reaches Eve", async () => {
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async () => new Response([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "Оборванный ответ" }, index: 0 }],
          created: 1,
          id: "completion-truncated",
          model: "compatible-model",
          object: "chat.completion.chunk",
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "length", index: 0 }],
          created: 1,
          id: "completion-truncated",
          model: "compatible-model",
          object: "chat.completion.chunk",
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
      maxOutputTokens: 8_000,
      modelId: "compatible-model",
      transport: {
        baseUrl: "https://example-provider.test/v1",
        protocol: "openai-chat-completions",
        providerName: "compatible-provider",
        reasoning: null,
      },
    });
    const { stream } = await model.doStream({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions);

    await expect(async () => {
      for await (const _part of stream) {
        // Full consumption proves the terminal finish event is rejected.
      }
    }).rejects.toThrow("AGENT_MODEL_OUTPUT_TRUNCATED");
  });

  it("preserves native Anthropic thinking signatures through a tool turn", async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers; url: string }> = [];
    const responses = [
      jsonResponse({
        content: [
          { signature: SIGNATURE, thinking: "Нужно вызвать инструмент.", type: "thinking" },
          {
            id: "call_weather_001",
            input: { city: "Москва" },
            name: "get_weather",
            type: "tool_use",
          },
        ],
        id: "msg_tool_001",
        model: "MiniMax-M3",
        role: "assistant",
        stop_reason: "tool_use",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 20, output_tokens: 14 },
      }),
      jsonResponse({
        content: [{ text: "В Москве 18 градусов.", type: "text" }],
        id: "msg_text_001",
        model: "MiniMax-M3",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 30, output_tokens: 8 },
      }),
    ];
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async (input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
          url: String(input),
        });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected model request");
        return response;
      },
      modelId: "MiniMax-M3",
      maxOutputTokens: 128_000,
      transport: {
        authentication: "bearer",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    const result = await generateText({
      maxRetries: 0,
      model,
      prompt: "Какая погода в Москве?",
      stopWhen: stepCountIs(2),
      tools: {
        get_weather: tool({
          execute: async () => ({ temperatureC: 18 }),
          inputSchema: z.object({ city: z.string() }),
        }),
      },
    });

    expect(requests).toHaveLength(2);
    expect(result.text).toBe("В Москве 18 градусов.");
    expect(requests[0]).toMatchObject({
      body: { thinking: { type: "adaptive" } },
      url: "https://api.minimax.io/anthropic/v1/messages",
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer model-secret");
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({
            signature: SIGNATURE,
            thinking: "Нужно вызвать инструмент.",
            type: "thinking",
          }),
        ]),
        role: "assistant",
      }),
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ tool_use_id: "call_weather_001", type: "tool_result" }),
        ]),
        role: "user",
      }),
    ]));
  });

  it("streams thinking separately from the complete visible answer", async () => {
    const model = createConfiguredLanguageModel({
      apiKey: "model-secret",
      fetch: async () => sse([
        messageStart("msg_text_002"),
        ...thinkingEvents,
        {
          data: { content_block: { text: "", type: "text" }, index: 1, type: "content_block_start" },
          event: "content_block_start",
        },
        {
          data: {
            delta: { text: "Проверила: всё работает.", type: "text_delta" },
            index: 1,
            type: "content_block_delta",
          },
          event: "content_block_delta",
        },
        { data: { index: 1, type: "content_block_stop" }, event: "content_block_stop" },
        {
          data: {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            type: "message_delta",
            usage: { input_tokens: 20, output_tokens: 12 },
          },
          event: "message_delta",
        },
        { data: { type: "message_stop" }, event: "message_stop" },
      ]),
      maxOutputTokens: 128_000,
      modelId: "MiniMax-M3",
      transport: {
        authentication: "bearer",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        protocol: "anthropic-messages",
        reasoning: { mode: "adaptive", type: "enabled" },
      },
    });

    const result = streamText({ maxRetries: 0, model, prompt: "Проверь систему" });

    await expect(Promise.all([result.reasoningText, result.text])).resolves.toEqual([
      "Нужно вызвать инструмент.",
      "Проверила: всё работает.",
    ]);
  });
});
