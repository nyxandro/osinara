/**
 * What one model step leaves behind: history messages and the text the channel delivers.
 *
 * Exports:
 * - `EMPTY_DELIVERY_MARKER`, `containsEmptyDeliveryMarker`: the model's way to finish a turn without
 *   delivering anything.
 * - `isEmptyDelivery`: a final step that only carries the marker; it is not written into history.
 * - `stepHistoryMessages`: the assistant message(s) of a step and one tool message with every
 *   call's result in call order.
 * - `stepTextEvents`: the step's visible text as the channel receives it, split at tool calls.
 *
 * - The tool message is assembled from the journal, in call order; the provider pairs results with
 *   calls by id.
 * - Text events are produced after the step is recorded, not while it streams: a retried model
 *   call cannot deliver the text of its failed attempt.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { ModelMessage, ToolResultPart } from "ai";

import type { ToolResultOutput } from "./tool-calls.js";

export const EMPTY_DELIVERY_MARKER = "<empty-delivery/>";

export function containsEmptyDeliveryMarker(text: string): boolean {
  return text.includes(EMPTY_DELIVERY_MARKER);
}

export interface StepTextEvent {
  readonly finishReason: string;
  /** `null` is a deliberate silence. */
  readonly message: string | null;
}

export function isEmptyDelivery(input: { readonly finishReason: string; readonly text: string; readonly toolCallCount: number }): boolean {
  return input.finishReason !== "tool-calls" && input.toolCallCount === 0 && containsEmptyDeliveryMarker(input.text);
}

export function stepHistoryMessages(input: {
  readonly calls: ReadonlyArray<{ readonly callId: string; readonly output: ToolResultOutput; readonly toolName: string }>;
  readonly response: readonly ModelMessage[];
}): ModelMessage[] {
  // AI SDK's own tool message (results it synthesized for an unknown tool or a broken input) is
  // replaced: those results are journal calls like any other.
  const messages = input.response.filter((message) => message.role !== "tool");
  if (input.calls.length === 0) return messages;
  const content: ToolResultPart[] = input.calls.map((call) => ({
    type: "tool-result",
    toolCallId: call.callId,
    toolName: call.toolName,
    output: call.output,
  }));
  return [...messages, { role: "tool", content }];
}

export function stepTextEvents(response: readonly ModelMessage[], finishReason: string): StepTextEvent[] {
  const events: StepTextEvent[] = [];
  let text = "";
  for (const message of response) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      text += message.content;
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") text += part.text;
      if (part.type === "tool-call" && text.trim().length > 0) {
        events.push({ finishReason: "tool-calls", message: text });
        text = "";
      }
    }
  }
  if (finishReason !== "tool-calls" && containsEmptyDeliveryMarker(text)) {
    events.push({ finishReason, message: null });
  } else if (text.trim().length > 0) {
    events.push({ finishReason, message: text });
  }
  return events;
}
