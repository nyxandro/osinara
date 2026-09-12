/** Availability signals require completed useful output, not headers, deltas or failed streams. */
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { modelSuccessObserver } from "./model-success-observer.js";
import { modelRouteKey } from "./model-route.js";

const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" },
  usage: { inputTokens: {}, outputTokens: {} } } as LanguageModelV4StreamPart;
const text = { type: "text-delta", id: "text", delta: "Готово" } as const;

describe("model success observation", () => {
  it.each([
    { name: "complete text", parts: [text, finish], success: true },
    { name: "complete tool call", parts: [{ type: "tool-call", toolCallId: "id", toolName: "read", input: "{}" }, finish], success: true },
    { name: "empty output", parts: [finish], success: false },
    { name: "unfinished output", parts: [text], success: false },
    { name: "error after finish", parts: [text, finish, { type: "error", error: new Error("Provider failure") }], success: false },
  ])("$name", async ({ parts, success }) => {
    const onSuccess = vi.fn();
    const middleware = modelSuccessObserver("a".repeat(64), onSuccess);
    const result = await middleware.wrapStream!({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    } }) }) } as never);
    for await (const _ of result.stream) { /* Consume the real stream wrapper. */ }
    expect(onSuccess).toHaveBeenCalledTimes(success ? 1 : 0);
  });

  it("does not lose a successful answer when observation storage fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const middleware = modelSuccessObserver("a".repeat(64), async () => { throw new Error("DB unavailable"); });
      const answer = { content: [{ type: "text", text: "Готово" }], finishReason: { unified: "stop" } };
      expect(await middleware.wrapGenerate!({ doGenerate: async () => answer } as never)).toBe(answer);
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it("does not turn cancellation into a successful observation", async () => {
    const onSuccess = vi.fn();
    const middleware = modelSuccessObserver("a".repeat(64), onSuccess);
    const result = await middleware.wrapStream!({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
      controller.enqueue(text);
    } }) }) } as never);
    const reader = result.stream.getReader();
    await reader.read();
    await reader.cancel();
    reader.releaseLock();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("separates models and provider endpoints while ignoring object identity", () => {
    const transport = { protocol: "openai-chat-completions", providerName: "provider", baseUrl: "https://one.invalid/v1", reasoning: null } as const;
    const route = modelRouteKey(transport, "model");
    expect(modelRouteKey({ ...transport }, "model")).toBe(route);
    expect(modelRouteKey(transport, "vision")).not.toBe(route);
    expect(modelRouteKey({ ...transport, baseUrl: "https://two.invalid/v1" }, "model")).not.toBe(route);
    expect(route).toMatch(/^[0-9a-f]{64}$/u);
  });
});
