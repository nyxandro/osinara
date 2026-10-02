import type { ModelMessage, UserContent } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  instructionTurnMessages,
  resolveTurnInstructions,
  turnInputMessages,
  type InstructionResolveContext,
} from "./turn-instructions.js";

const HISTORY: ModelMessage[] = [{ role: "user", content: "предыдущая служебная реплика" }];

function resolveContext(messages: readonly ModelMessage[] = HISTORY): InstructionResolveContext {
  return {
    channel: { kind: "telegram" },
    messages,
    session: { auth: { current: null, initiator: null }, id: "wrun_01M3YNFXVX5WCP17ZVB8ZTMQAR" },
    turnId: "turn_01M3YNFXVX5WCP17ZVB8ZTMQAS",
  };
}

describe("messages instruction resolvers see", () => {
  it("include this turn's context and message after the stored history, without changing it", () => {
    const message = '<current_telegram_message>{"text":"текущий вопрос","sourceSequence":"123"}</current_telegram_message>';

    expect(instructionTurnMessages(HISTORY, { context: ["контекст канала"], message })).toEqual([
      ...HISTORY,
      { role: "user", content: "контекст канала" },
      { role: "user", content: message },
    ]);
    expect(HISTORY).toEqual([{ role: "user", content: "предыдущая служебная реплика" }]);
  });

  it("keep structured message parts of a delegated child task", () => {
    const message: UserContent = [{ type: "text", text: "задача ребёнка" }];

    expect(instructionTurnMessages(HISTORY, { context: [], message }).at(-1)).toEqual({ role: "user", content: message });
  });

  it("invent no user message for an answer to a prompt or a context-only wake", () => {
    expect(instructionTurnMessages(HISTORY, { context: [] })).toBe(HISTORY);
    expect(instructionTurnMessages(HISTORY, { context: ["причина отмены"] })).toBe(HISTORY);
    expect(instructionTurnMessages(HISTORY, { context: [], message: "   " })).toBe(HISTORY);
  });
});

describe("turn instruction resolvers", () => {
  it("return system blocks in resolver order and user blocks separately, trimmed", async () => {
    const resolved = await resolveTurnInstructions([
      { name: "conversation-mode", resolve: () => ({ role: "system", content: "\n# Режим\n" }) },
      { name: "delegation", resolve: () => null },
      { name: "reaction-set", resolve: async () => ({ role: "user", content: "<telegram_chat_reactions>👍</telegram_chat_reactions>" }) },
      { name: "presentation-preferences", resolve: () => ({ role: "system", content: "   " }) },
      { name: "retrieved-memory", resolve: async () => ({ role: "system", content: "<osinara_turn_memory/>" }) },
    ], resolveContext());

    expect(resolved).toEqual({
      system: ["# Режим", "<osinara_turn_memory/>"],
      user: [{ role: "user", content: "<telegram_chat_reactions>👍</telegram_chat_reactions>" }],
    });
  });

  it("give every resolver the same view of the turn", async () => {
    const seen = vi.fn(() => null);
    const context = resolveContext();

    await resolveTurnInstructions([{ name: "a", resolve: seen }, { name: "b", resolve: seen }], context);

    expect(seen).toHaveBeenNthCalledWith(1, context);
    expect(seen).toHaveBeenNthCalledWith(2, context);
  });

  it("stop the turn before the model when a resolver fails, instead of dropping its rules", async () => {
    const failure = new Error("база недоступна");

    await expect(resolveTurnInstructions([
      { name: "conversation-mode", resolve: () => { throw failure; } },
    ], resolveContext())).rejects.toMatchObject({
      code: "AGENT_TURN_INSTRUCTIONS_FAILED",
      cause: failure,
      details: { resolver: "conversation-mode" },
    });
  });
});

describe("turn input messages", () => {
  it("place user-role blocks, then context, then the message, as the stored order of a turn", () => {
    expect(turnInputMessages({
      context: ["<telegram_context>", "Verified role: owner."],
      message: "<current_telegram_message/>",
      userInstructions: [{ role: "user", content: "<telegram_chat_reactions/>" }],
    })).toEqual([
      { role: "user", content: "<telegram_chat_reactions/>" },
      { role: "user", content: "<telegram_context>" },
      { role: "user", content: "Verified role: owner." },
      { role: "user", content: "<current_telegram_message/>" },
    ]);
  });

  it("omit an empty message", () => {
    expect(turnInputMessages({ context: ["строка"], message: [{ type: "text", text: " " }], userInstructions: [] }))
      .toEqual([{ role: "user", content: "строка" }]);
  });
});
