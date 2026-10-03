import { describe, expect, it } from "vitest";

import { containsEmptyDeliveryMarker, EMPTY_DELIVERY_MARKER, isEmptyDelivery, stepHistoryMessages, stepTextEvents } from "./step-history.js";

describe("step text events", () => {
  it("delivers text written before a tool call as its own message", () => {
    expect(stepTextEvents([{ role: "assistant", content: [
      { type: "text", text: "Сейчас " }, { type: "text", text: "проверю." },
      { type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} },
      { type: "text", text: "  " },
      { type: "tool-call", toolCallId: "c2", toolName: "bash", input: {} },
    ] }], "tool-calls")).toEqual([{ finishReason: "tool-calls", message: "Сейчас проверю." }]);
  });

  it("delivers the final text with the step's finish reason", () => {
    expect(stepTextEvents([{ role: "assistant", content: [{ type: "reasoning", text: "думаю" }, { type: "text", text: "Готово" }] }], "stop"))
      .toEqual([{ finishReason: "stop", message: "Готово" }]);
  });

  it("turns the empty-delivery marker into a deliberate silence, but not inside a tool step", () => {
    expect(EMPTY_DELIVERY_MARKER).toBe("<empty-delivery/>");
    expect(stepTextEvents([{ role: "assistant", content: "<empty-delivery/>" }], "stop")).toEqual([{ finishReason: "stop", message: null }]);
    expect(stepTextEvents([{ role: "assistant", content: [{ type: "text", text: "<empty-delivery/>" }] }], "tool-calls"))
      .toEqual([{ finishReason: "tool-calls", message: "<empty-delivery/>" }]);
    expect(isEmptyDelivery({ finishReason: "stop", text: "ничего нового <empty-delivery/>", toolCallCount: 0 })).toBe(true);
    expect(isEmptyDelivery({ finishReason: "stop", text: "<empty-delivery/>", toolCallCount: 1 })).toBe(false);
  });

  it("still understands the previous marker, which the model may repeat after earlier turns in its history", () => {
    expect(stepTextEvents([{ role: "assistant", content: "<eve-empty-delivery/>" }], "stop")).toEqual([{ finishReason: "stop", message: null }]);
    expect(isEmptyDelivery({ finishReason: "stop", text: "<eve-empty-delivery/>", toolCallCount: 0 })).toBe(true);
    expect(containsEmptyDeliveryMarker("Молчу <eve-empty-delivery/>")).toBe(true);
    expect(containsEmptyDeliveryMarker("обычный ответ")).toBe(false);
  });
});

describe("step history messages", () => {
  it("writes every call's result into one tool message in call order, replacing AI SDK's own", () => {
    const assistant = { role: "assistant" as const, content: [
      { type: "tool-call" as const, toolCallId: "c1", toolName: "nope", input: {} },
      { type: "tool-call" as const, toolCallId: "c2", toolName: "bash", input: { command: "ls" } },
    ] };
    const sdkTool = { role: "tool" as const, content: [
      { type: "tool-result" as const, toolCallId: "c1", toolName: "nope", output: { type: "error-text" as const, value: "Model tried to call unavailable tool 'nope'." } },
    ] };

    expect(stepHistoryMessages({
      calls: [
        { callId: "c1", output: { type: "error-text", value: "Model tried to call unavailable tool 'nope'." }, toolName: "nope" },
        { callId: "c2", output: { type: "text", value: "a.txt" }, toolName: "bash" },
      ],
      response: [assistant, sdkTool],
    })).toEqual([assistant, { role: "tool", content: [
      { type: "tool-result", toolCallId: "c1", toolName: "nope", output: { type: "error-text", value: "Model tried to call unavailable tool 'nope'." } },
      { type: "tool-result", toolCallId: "c2", toolName: "bash", output: { type: "text", value: "a.txt" } },
    ] }]);
  });
});
