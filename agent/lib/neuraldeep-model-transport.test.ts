/**
 * NeuralDeep OpenAI-compatible transport contract tests.
 *
 * Constructs covered:
 * - `createConfiguredLanguageModel`: targets NeuralDeep's exact chat-completions endpoint.
 * - NeuralDeep receives Bearer authentication and the audited Qwen request output limit.
 * - Undocumented provider-specific reasoning controls are omitted from request payloads.
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { createConfiguredLanguageModel } from "./model-transport.js";

describe("NeuralDeep model transport", () => {
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
    } as LanguageModelV4CallOptions);

    expect(fetch).toHaveBeenCalledWith(
      "https://api.neuraldeep.ru/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer neuraldeep-secret" }),
        method: "POST",
      }),
    );
    expect(body).toMatchObject({ max_tokens: 16_384, model: "qwen3.8-27b" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });
});
