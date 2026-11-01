/**
 * What a message that points elsewhere borrows for the memory search of its turn.
 *
 * Constructs covered:
 * - A referring reply borrows the message it answers: from the envelope when it carries the text,
 *   otherwise from the conversation's journal.
 * - A short or referring message that answers nothing borrows the few messages before it.
 * - A self-contained or long message, small talk and a sticker borrow nothing and read no journal.
 * - A failed read of the journal costs the turn only the borrowed words.
 * - Every borrowed line is bounded.
 */
import { describe, expect, it, vi } from "vitest";

import { memoryQueryConversationContext, memoryTurnQueryContext } from "./memory-query-context.js";

// Production, 01.11.2026: the request answered the agent's own list of skills that named pohuy.
const REPLIED = "перепроверила всю ленту, прямого «Осинара, используй pohuy» в чате нигде нет";

function source(overrides: Partial<{ previous: string[]; replyText: string | null }> = {}) {
  return {
    previous: vi.fn().mockResolvedValue(overrides.previous ?? ["первое", "второе", "третье"]),
    replyTarget: vi.fn().mockResolvedValue(overrides.replyText === undefined ? REPLIED : overrides.replyText),
  };
}

const CONVERSATION = { conversationId: "conversation-1", sourceSequence: "59976" };

describe("memoryTurnQueryContext", () => {
  it("costs the turn only the borrowed words when the journal cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const journal = { previous: vi.fn(), replyTarget: vi.fn().mockRejectedValue(new Error("connection terminated")) };
    const auth = { current: { attributes: { telegramConversationId: "conversation-1", telegramTimelineSequence: "59975" },
      authenticator: "telegram", principalId: "user-1", principalType: "user" }, initiator: null } as never;
    const envelope = `<current_telegram_message>\n${JSON.stringify({ replyToSequenceId: "59699", sourceSequence: "59976", text: "а это что?" })}\n</current_telegram_message>`;

    await expect(memoryTurnQueryContext(journal, auth, [{ content: envelope, role: "user" }], "а это что?")).resolves.toBeNull();
    expect(error.mock.calls.map((call) => JSON.parse(String(call[0])))).toContainEqual(
      expect.objectContaining({ code: "AGENT_MEMORY_QUERY_CONTEXT_FAILED" }));
    error.mockRestore();
  });
});

describe("memoryQueryConversationContext", () => {
  it("borrows the message a referring reply answers, from the journal", async () => {
    const journal = source();

    const context = await memoryQueryConversationContext(journal, {
      ...CONVERSATION, replyText: null, replyToSequenceId: "59699", text: "Кинь ссылку на эти скилы",
    });

    expect(context).toEqual({ kind: "reply", text: REPLIED });
    expect(journal.replyTarget).toHaveBeenCalledWith({ conversationId: "conversation-1", sequenceId: "59699" });
    expect(journal.previous).not.toHaveBeenCalled();
  });

  it("takes the replied text the envelope already carries without reading the journal", async () => {
    const journal = source();

    const context = await memoryQueryConversationContext(journal, {
      ...CONVERSATION, replyText: "скилл pohuy", replyToSequenceId: "59699", text: "а ссылку?",
    });

    expect(context).toEqual({ kind: "reply", text: "скилл pohuy" });
    expect(journal.replyTarget).not.toHaveBeenCalled();
  });

  it("borrows the messages before a short message that answers nothing, oldest first", async () => {
    const journal = source({ previous: ["третье", "второе", "первое"] });

    const context = await memoryQueryConversationContext(journal, {
      ...CONVERSATION, replyText: null, replyToSequenceId: null, text: "а ссылку на него?",
    });

    expect(context).toEqual({ kind: "previous", text: "первое\nвторое\nтретье" });
    expect(journal.previous).toHaveBeenCalledWith({ before: "59976", conversationId: "conversation-1", limit: 3 });
  });

  it.each([
    ["a self-contained question", "посоветуй хороший VPS в Европе дешевле десяти евро в месяц с почасовой оплатой"],
    ["a long message with a passing «это»", "Напомни мне завтра в девять утра записаться к стоматологу на чистку, это важно"],
    ["a short message that neither replies nor refers", "IT-отдел просит доступ"],
    ["small talk", "ахаха"],
    ["a sticker", "[стикер 😂]"],
  ])("borrows nothing for %s", async (_name, text) => {
    const journal = source();

    await expect(memoryQueryConversationContext(journal, {
      ...CONVERSATION, replyText: null, replyToSequenceId: null, text,
    })).resolves.toBeNull();
    expect(journal.replyTarget).not.toHaveBeenCalled();
    expect(journal.previous).not.toHaveBeenCalled();
  });

  it("bounds every borrowed line and borrows nothing outside a conversation", async () => {
    const journal = source({ replyText: "я".repeat(5_000) });

    const context = await memoryQueryConversationContext(journal, {
      ...CONVERSATION, replyText: null, replyToSequenceId: "59699", text: "а это что?",
    });
    expect(context!.text.length).toBeLessThanOrEqual(400);

    await expect(memoryQueryConversationContext(journal, {
      conversationId: null, replyText: null, replyToSequenceId: null, sourceSequence: null, text: "а это что?",
    })).resolves.toBeNull();
  });
});
