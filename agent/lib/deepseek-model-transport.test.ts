/**
 * DeepSeek OpenAI-compatible transport contract tests.
 *
 * Constructs covered:
 * - Explicit thinking controls are sent on every DeepSeek model request.
 * - Non-thinking background calls can force one schema-bearing tool.
 * - `reasoning_content` remains separate from visible output.
 * - Tool-call reasoning is replayed exactly as required by DeepSeek multi-round context.
 * - Approval-only tool calls are removed unless a real tool result completes the pair.
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createConfiguredLanguageModel } from "./model-transport.js";

function completion(message: Record<string, unknown>, finishReason: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, index: 0, message }],
    created: 1,
    id: "deepseek-completion",
    model: "deepseek-v4-flash",
    object: "chat.completion",
    usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function streamCompletion(chunks: readonly Record<string, unknown>[]): Response {
  return new Response([
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join(""), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

function deepSeekModel(fetch: typeof globalThis.fetch) {
  return createConfiguredLanguageModel({
    apiKey: "deepseek-secret",
    fetch,
    maxOutputTokens: 128_000,
    modelId: "deepseek-v4-flash",
    transport: {
      baseUrl: "https://api.deepseek.com",
      protocol: "openai-chat-completions",
      providerName: "deepseek",
      reasoning: { effort: "high", format: "deepseek", type: "effort" },
    },
  });
}

describe("DeepSeek model transport", () => {
  it("sends explicit thinking controls and keeps reasoning out of visible text", async () => {
    let body: Record<string, unknown> | undefined;
    const model = deepSeekModel(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completion({
        content: "Видимый ответ.",
        reasoning_content: "Скрытое рассуждение.",
        role: "assistant",
      }, "stop");
    });

    const result = await model.doGenerate({
      prompt: [{ content: [{ text: "Проверка", type: "text" }], role: "user" }],
    } as LanguageModelV4CallOptions);

    expect(body).toMatchObject({
      max_tokens: 128_000,
      model: "deepseek-v4-flash",
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(result.content).toEqual(expect.arrayContaining([
      { text: "Скрытое рассуждение.", type: "reasoning" },
      { text: "Видимый ответ.", type: "text" },
    ]));
    expect(result.content.filter((part) => part.type === "text")).toEqual([
      { text: "Видимый ответ.", type: "text" },
    ]);
  });

  it("forces a schema-bearing tool when background thinking is explicitly disabled", async () => {
    let body: Record<string, unknown> | undefined;
    const model = createConfiguredLanguageModel({
      apiKey: "deepseek-secret",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return completion({
          content: null,
          role: "assistant",
          tool_calls: [{
            function: {
              arguments: JSON.stringify({ decisions: ["save"] }),
              name: "submit_memory_test",
            },
            id: "call_memory_001",
            type: "function",
          }],
        }, "tool_calls");
      },
      maxOutputTokens: 2_048,
      modelId: "deepseek-v4-flash",
      transport: {
        baseUrl: "https://api.deepseek.com",
        protocol: "openai-chat-completions",
        providerName: "deepseek",
        reasoning: { format: "deepseek", type: "none" },
      },
    });

    const result = await generateText({
      maxRetries: 0,
      model,
      prompt: "Классифицируй память",
      toolChoice: { toolName: "submit_memory_test", type: "tool" },
      tools: {
        submit_memory_test: tool({
          inputSchema: z.object({ decisions: z.array(z.string()) }).strict(),
        }),
      },
    });

    expect(body).toMatchObject({
      thinking: { type: "disabled" },
      tool_choice: { function: { name: "submit_memory_test" }, type: "function" },
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        input: { decisions: ["save"] },
        toolName: "submit_memory_test",
      }),
    ]);
  });

  it("replays tool-call reasoning before sending the tool result", async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [
      completion({
        content: null,
        reasoning_content: "Нужно получить время.",
        role: "assistant",
        tool_calls: [{
          function: { arguments: "{}", name: "get_time" },
          id: "call_time_001",
          type: "function",
        }],
      }, "tool_calls"),
      completion({
        content: "Сейчас 12:00.",
        reasoning_content: "Инструмент вернул точное время.",
        role: "assistant",
      }, "stop"),
    ];
    const model = deepSeekModel(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected DeepSeek request");
      return response;
    });

    const result = await generateText({
      maxRetries: 0,
      model,
      prompt: "Который час?",
      stopWhen: stepCountIs(2),
      tools: {
        get_time: tool({
          execute: async () => ({ time: "12:00" }),
          inputSchema: z.object({}),
        }),
      },
    });

    expect(result.text).toBe("Сейчас 12:00.");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reasoning_content: "Нужно получить время.",
        role: "assistant",
        tool_calls: expect.arrayContaining([
          expect.objectContaining({ id: "call_time_001" }),
        ]),
      }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_time_001" }),
    ]));
    expect(requests[1]).toMatchObject({
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
  });

  it("removes approval-only tool calls while preserving completed tool pairs", async () => {
    let body: Record<string, unknown> | undefined;
    const model = deepSeekModel(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completion({
        content: "История обработана.",
        reasoning_content: "Продолжаю после подтверждения.",
        role: "assistant",
      }, "stop");
    });

    // A turn can resume with an approved call that has no execution result yet. DeepSeek only accepts
    // assistant tool calls that have a corresponding tool message in the serialized history.
    await model.doGenerate({
      prompt: [
        { content: [{ text: "Подготовь операции", type: "text" }], role: "user" },
        {
          content: [
            { text: "Нужно выполнить операции.", type: "reasoning" },
            {
              input: { id: "done" },
              toolCallId: "call_completed",
              toolName: "mutate",
              type: "tool-call",
            },
            {
              input: { id: "approved" },
              toolCallId: "call_approval_only",
              toolName: "mutate",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        {
          content: [{
            output: { type: "json", value: { ok: true } },
            toolCallId: "call_completed",
            toolName: "mutate",
            type: "tool-result",
          }],
          role: "tool",
        },
        { content: [{ text: "Продолжай", type: "text" }], role: "user" },
      ],
    } as LanguageModelV4CallOptions);

    const serialized = JSON.stringify(body?.messages);
    expect(serialized).toContain("call_completed");
    expect(serialized).not.toContain("call_approval_only");
    expect(body?.messages).toEqual([
      { content: "Подготовь операции", role: "user" },
      expect.objectContaining({
        reasoning_content: "Нужно выполнить операции.",
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "call_completed" })],
      }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_completed" }),
      { content: "Продолжай", role: "user" },
    ]);
  });

  it("removes misordered tool results instead of pairing them across a user message", async () => {
    let body: Record<string, unknown> | undefined;
    const model = deepSeekModel(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completion({ content: "Готово.", role: "assistant" }, "stop");
    });

    await model.doGenerate({
      prompt: [
        {
          content: [{
            input: {},
            toolCallId: "call_misordered",
            toolName: "probe",
            type: "tool-call",
          }],
          role: "assistant",
        },
        { content: [{ text: "Новый запрос", type: "text" }], role: "user" },
        {
          content: [{
            output: { type: "json", value: { ok: true } },
            toolCallId: "call_misordered",
            toolName: "probe",
            type: "tool-result",
          }],
          role: "tool",
        },
      ],
    } as LanguageModelV4CallOptions);

    expect(body?.messages).toEqual([{ content: "Новый запрос", role: "user" }]);
  });

  it("removes provider-executed calls that the compatible wire cannot represent as completed", async () => {
    let body: Record<string, unknown> | undefined;
    const model = deepSeekModel(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completion({ content: "Готово.", role: "assistant" }, "stop");
    });

    await model.doGenerate({
      prompt: [
        {
          content: [{
            input: { query: "пример" },
            providerExecuted: true,
            toolCallId: "call_provider",
            toolName: "provider_search",
            type: "tool-call",
          }],
          role: "assistant",
        },
        { content: [{ text: "Продолжай", type: "text" }], role: "user" },
      ],
    } as LanguageModelV4CallOptions);

    expect(body?.messages).toEqual([{ content: "Продолжай", role: "user" }]);
  });

  it("streams reasoning separately and exposes only final content as text", async () => {
    const model = deepSeekModel(async () => streamCompletion([
      {
        choices: [{ delta: { reasoning_content: "Скрытый анализ." }, index: 0 }],
        created: 1,
        id: "deepseek-stream",
        model: "deepseek-v4-flash",
        object: "chat.completion.chunk",
      },
      {
        choices: [{ delta: { content: "Итоговый ответ." }, index: 0 }],
        created: 1,
        id: "deepseek-stream",
        model: "deepseek-v4-flash",
        object: "chat.completion.chunk",
      },
      {
        choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
        created: 1,
        id: "deepseek-stream",
        model: "deepseek-v4-flash",
        object: "chat.completion.chunk",
        usage: { completion_tokens: 4, prompt_tokens: 5, total_tokens: 9 },
      },
    ]));

    const result = streamText({ maxRetries: 0, model, prompt: "Проверь поток" });

    await expect(Promise.all([result.reasoningText, result.text])).resolves.toEqual([
      "Скрытый анализ.",
      "Итоговый ответ.",
    ]);
  });

  it("replays reasoning from a streamed tool call before the next streamed step", async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [
      streamCompletion([
        {
          choices: [{ delta: { reasoning_content: "Нужно вызвать проверку." }, index: 0 }],
          created: 1,
          id: "deepseek-stream-tool",
          model: "deepseek-v4-flash",
          object: "chat.completion.chunk",
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                function: { arguments: "{}", name: "probe" },
                id: "call_probe_001",
                index: 0,
                type: "function",
              }],
            },
            index: 0,
          }],
          created: 1,
          id: "deepseek-stream-tool",
          model: "deepseek-v4-flash",
          object: "chat.completion.chunk",
        },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          created: 1,
          id: "deepseek-stream-tool",
          model: "deepseek-v4-flash",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 5, prompt_tokens: 10, total_tokens: 15 },
        },
      ]),
      streamCompletion([
        {
          choices: [{ delta: { reasoning_content: "Проверка успешна." }, index: 0 }],
          created: 1,
          id: "deepseek-stream-final",
          model: "deepseek-v4-flash",
          object: "chat.completion.chunk",
        },
        {
          choices: [{ delta: { content: "Готово." }, index: 0 }],
          created: 1,
          id: "deepseek-stream-final",
          model: "deepseek-v4-flash",
          object: "chat.completion.chunk",
        },
        {
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          created: 1,
          id: "deepseek-stream-final",
          model: "deepseek-v4-flash",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 4, prompt_tokens: 15, total_tokens: 19 },
        },
      ]),
    ];
    const model = deepSeekModel(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected streamed DeepSeek request");
      return response;
    });

    const result = streamText({
      maxRetries: 0,
      model,
      prompt: "Запусти проверку",
      stopWhen: stepCountIs(2),
      tools: {
        probe: tool({ execute: async () => ({ ok: true }), inputSchema: z.object({}) }),
      },
    });

    await expect(result.text).resolves.toBe("Готово.");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reasoning_content: "Нужно вызвать проверку.",
        role: "assistant",
        tool_calls: expect.arrayContaining([
          expect.objectContaining({ id: "call_probe_001" }),
        ]),
      }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_probe_001" }),
    ]));
  });
});
