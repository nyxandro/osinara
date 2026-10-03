/**
 * fast-check generators of AI SDK conversation history, shared by the runtime's history tests.
 *
 * Export:
 * - `modelHistoryArbitrary`: message arrays shaped like stored sessions: user context blocks and
 *   messages, assistant text, reasoning and tool calls with provider metadata, tool results.
 *
 * Test-only: imported by `*.test.ts` files, never by runtime code.
 */
import fc from "fast-check";

const text = fc.string({ unit: "grapheme", maxLength: 40 });
const callId = fc.stringMatching(/^[a-z][a-z0-9-]{0,24}$/);
const toolName = fc.stringMatching(/^[a-z][a-z_]{0,24}$/);
const json = fc.jsonValue({ maxDepth: 3 });
const providerOptions = fc.dictionary(fc.constantFrom("anthropic", "openaiCompatible", "deepseek"), fc.dictionary(text, json, { maxKeys: 3 }), { maxKeys: 2 });

const userMessage = fc.oneof(
  fc.record({ role: fc.constant("user"), content: text }),
  fc.record({ role: fc.constant("user"), content: fc.array(fc.record({ type: fc.constant("text"), text }), { minLength: 1, maxLength: 3 }) }),
);

const assistantPart = fc.oneof(
  fc.record({ type: fc.constant("text"), text, providerOptions }, { requiredKeys: ["type", "text"] }),
  fc.record({ type: fc.constant("reasoning"), text, providerOptions }, { requiredKeys: ["type", "text"] }),
  fc.record({ type: fc.constant("tool-call"), toolCallId: callId, toolName, input: json, providerOptions }, { requiredKeys: ["type", "toolCallId", "toolName", "input"] }),
);

const toolOutput = fc.oneof(
  fc.record({ type: fc.constant("json"), value: json }),
  fc.record({ type: fc.constant("text"), value: text }),
  fc.record({ type: fc.constant("error-text"), value: text }),
);

const assistantMessage = fc.record({ role: fc.constant("assistant"), content: fc.array(assistantPart, { minLength: 1, maxLength: 4 }) });
const toolMessage = fc.record({
  role: fc.constant("tool"),
  content: fc.array(fc.record({ type: fc.constant("tool-result"), toolCallId: callId, toolName, output: toolOutput }), { minLength: 1, maxLength: 3 }),
});

export const modelHistoryArbitrary = fc.array(fc.oneof(userMessage, assistantMessage, toolMessage), { maxLength: 12 });
