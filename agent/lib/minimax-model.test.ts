/**
 * MiniMax OpenAI-compatible model boundary tests.
 *
 * Constructs covered:
 * - `createMiniMaxCliProxyModel`: adds `reasoning_split` to every request.
 * - MiniMax `reasoning_details` survives a complete assistant/tool round trip.
 * - Incremental streaming reasoning metadata is reconstructed on the AI SDK reasoning part.
 * - Multiple reasoning history parts serialize one complete MiniMax details envelope.
 * - Inline reasoning is normalized into reasoning parts without leaking into visible text.
 * - Redundant closing tags after structured reasoning are suppressed as provider separators.
 * - Malformed inline reasoning still fails closed instead of exposing internal content.
 */
import { describe, expect, it } from "vitest";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { streamText } from "ai";

import { createMiniMaxCliProxyModel } from "./minimax-model.js";

const REASONING_DETAILS = [{
  format: "MiniMax-response-v1",
  id: "reasoning-text-1",
  index: 0,
  text: "Проверяю погоду через инструмент.",
  type: "reasoning.text",
}] as const;
const REASONING_DETAILS_FRAGMENT_ONE = [{
  ...REASONING_DETAILS[0],
  text: "Проверяю ",
}];
const REASONING_DETAILS_FRAGMENT_TWO = [{
  ...REASONING_DETAILS[0],
  text: "погоду через инструмент.",
}];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function completion(message: Record<string, unknown>, finishReason: string) {
  return {
    choices: [{ finish_reason: finishReason, index: 0, message }],
    created: 1,
    id: "completion-1",
    model: "MiniMax-M3",
    object: "chat.completion",
    usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
  };
}

function userPrompt(): LanguageModelV4Prompt {
  return [{
    content: [{ text: "Какая погода?", type: "text" }],
    role: "user",
  }];
}

function assistantPrompt(content: LanguageModelV4Content[]): LanguageModelV4Prompt[number] {
  return {
    content: content.map((part) => {
      if (part.type === "reasoning") {
        return {
          providerOptions: part.providerMetadata,
          text: part.text,
          type: "reasoning" as const,
        };
      }
      if (part.type === "tool-call") {
        return {
          input: JSON.parse(part.input) as Record<string, unknown>,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          type: "tool-call" as const,
        };
      }
      if (part.type === "text") {
        return { text: part.text, type: "text" as const };
      }
      throw new Error(`Unexpected content part in test: ${part.type}`);
    }),
    role: "assistant",
  };
}

function toolResultPrompt(): LanguageModelV4Prompt[number] {
  return {
    content: [{
      output: { type: "text", value: "24 C, солнечно" },
      toolCallId: "call-weather-1",
      toolName: "get_weather",
      type: "tool-result",
    }],
    role: "tool",
  };
}

describe("createMiniMaxCliProxyModel", () => {
  it("preserves exact reasoning_details through an assistant/tool round trip", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const responses = [
      completion({
        content: "",
        reasoning_content: REASONING_DETAILS[0].text,
        reasoning_details: REASONING_DETAILS,
        role: "assistant",
        tool_calls: [{
          function: { arguments: '{"location":"Москва"}', name: "get_weather" },
          id: "call-weather-1",
          type: "function",
        }],
      }, "tool_calls"),
      completion({ content: "Сейчас солнечно.", role: "assistant" }, "stop"),
    ];
    const model = createMiniMaxCliProxyModel({
      apiKey: "proxy-key",
      baseURL: "http://cli-proxy-api:8317/v1",
      fetch: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(responses.shift());
      },
      modelId: "MiniMax-M3",
    });

    const first = await model.doGenerate({ prompt: userPrompt() } as LanguageModelV4CallOptions);
    const reasoning = first.content.find((part) => part.type === "reasoning");
    expect(reasoning?.providerMetadata?.openaiCompatible?.reasoningDetails).toEqual(
      REASONING_DETAILS,
    );

    await model.doGenerate({
      prompt: [userPrompt()[0]!, assistantPrompt(first.content), toolResultPrompt()],
    } as LanguageModelV4CallOptions);

    expect(requestBodies[0]).toMatchObject({ reasoning_split: true });
    expect(requestBodies[1]).toMatchObject({
      messages: [
        expect.any(Object),
        expect.objectContaining({
          reasoning_content: REASONING_DETAILS[0].text,
          reasoning_details: REASONING_DETAILS,
        }),
        expect.any(Object),
      ],
      reasoning_split: true,
    });
  });

  it("keeps streaming reasoning_details on the completed reasoning part", async () => {
    const eventStream = [
      `data: ${JSON.stringify({ choices: [{ delta: {
        reasoning_content: REASONING_DETAILS_FRAGMENT_ONE[0].text,
        reasoning_details: REASONING_DETAILS_FRAGMENT_ONE,
      }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {
        reasoning_content: REASONING_DETAILS_FRAGMENT_TWO[0].text,
        reasoning_details: REASONING_DETAILS_FRAGMENT_TWO,
      }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "</THINK>Готовый ответ" }, finish_reason: "stop", index: 0 }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const model = createMiniMaxCliProxyModel({
      apiKey: "proxy-key",
      baseURL: "http://cli-proxy-api:8317/v1",
      fetch: async () => new Response(eventStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
      modelId: "MiniMax-M3",
    });

    const { stream } = await model.doStream({ prompt: userPrompt() } as LanguageModelV4CallOptions);
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of stream) parts.push(part);

    expect(parts.find((part) => part.type === "reasoning-delta")).toMatchObject({
      delta: REASONING_DETAILS_FRAGMENT_ONE[0].text,
    });
    expect(parts.find((part) => part.type === "reasoning-end")).toMatchObject({
      providerMetadata: {
        openaiCompatible: { reasoningDetails: REASONING_DETAILS },
      },
    });
    expect(parts.find((part) => part.type === "text-delta")).toMatchObject({
      delta: "Готовый ответ",
    });
  });

  it("combines incremental reasoning metadata from assistant history parts", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const model = createMiniMaxCliProxyModel({
      apiKey: "proxy-key",
      baseURL: "http://cli-proxy-api:8317/v1",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(completion({ content: "Готово.", role: "assistant" }, "stop"));
      },
      modelId: "MiniMax-M3",
    });
    const reasoningParts: LanguageModelV4Content[] = [
      {
        providerMetadata: {
          openaiCompatible: { reasoningDetails: REASONING_DETAILS_FRAGMENT_ONE },
        },
        text: REASONING_DETAILS_FRAGMENT_ONE[0].text,
        type: "reasoning",
      },
      {
        providerMetadata: {
          openaiCompatible: { reasoningDetails: REASONING_DETAILS_FRAGMENT_TWO },
        },
        text: REASONING_DETAILS_FRAGMENT_TWO[0].text,
        type: "reasoning",
      },
    ];

    await model.doGenerate({
      prompt: [userPrompt()[0]!, assistantPrompt(reasoningParts)],
    } as LanguageModelV4CallOptions);

    expect(requestBody).toMatchObject({
      messages: [
        expect.any(Object),
        expect.objectContaining({ reasoning_details: REASONING_DETAILS }),
      ],
    });
  });

  it("normalizes case-variant inline reasoning in a generated response", async () => {
    const model = createMiniMaxCliProxyModel({
      apiKey: "proxy-key",
      baseURL: "http://cli-proxy-api:8317/v1",
      fetch: async () => jsonResponse(completion({
        content: "<THINK>Скрытое рассуждение</THINK>Ответ",
        role: "assistant",
      }, "stop")),
      modelId: "MiniMax-M3",
    });

    const result = await model.doGenerate({
      prompt: userPrompt(),
    } as LanguageModelV4CallOptions);

    expect(result.content).toEqual([
      { text: "Скрытое рассуждение", type: "reasoning" },
      { text: "Ответ", type: "text" },
    ]);
  });

  it("normalizes inline reasoning split across stream chunks", async () => {
    const eventStream = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<thi" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "nk>Скрыто" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "е рассуждение</TH" }, index: 0 }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "INK>Ответ" }, finish_reason: "stop", index: 0 }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const model = createMiniMaxCliProxyModel({
      apiKey: "proxy-key",
      baseURL: "http://cli-proxy-api:8317/v1",
      fetch: async () => new Response(eventStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
      modelId: "MiniMax-M3",
    });

    const { stream } = await model.doStream({ prompt: userPrompt() } as LanguageModelV4CallOptions);
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of stream) parts.push(part);

    const contentParts = parts.filter((part) => [
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ].includes(part.type));
    expect(contentParts.map((part) => part.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ]);
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      expect.objectContaining({ delta: "Скрыто" }),
      expect.objectContaining({ delta: "е рассуждение" }),
    ]);
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      expect.objectContaining({ delta: "Ответ" }),
    ]);
  });

  it("exposes recovered reasoning safely through the public AI SDK stream", async () => {
    const eventStream = [
      `data: ${JSON.stringify({ choices: [{ delta: {
        content: "<think>Скрытое рассуждение</think>Готовый ответ",
      }, finish_reason: "stop", index: 0 }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const model = createMiniMaxCliProxyModel({
      apiKey: "proxy-key",
      baseURL: "http://cli-proxy-api:8317/v1",
      fetch: async () => new Response(eventStream, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
      modelId: "MiniMax-M3",
    });

    // Eve consumes the model through this AI SDK layer rather than reading raw provider parts.
    const result = streamText({ model, prompt: "Подготовь документ" });
    const [reasoningText, text] = await Promise.all([result.reasoningText, result.text]);

    expect(reasoningText).toBe("Скрытое рассуждение");
    expect(text).toBe("Готовый ответ");
  });

  it("fails closed when inline reasoning is not terminated", async () => {
    const model = createMiniMaxCliProxyModel({
      apiKey: "proxy-key",
      baseURL: "http://cli-proxy-api:8317/v1",
      fetch: async () => jsonResponse(completion({
        content: "<think>Скрытое рассуждение",
        role: "assistant",
      }, "stop")),
      modelId: "MiniMax-M3",
    });

    await expect(
      model.doGenerate({ prompt: userPrompt() } as LanguageModelV4CallOptions),
    ).rejects.toThrow("AGENT_MINIMAX_REASONING_CONTRACT_VIOLATION");
  });
});
