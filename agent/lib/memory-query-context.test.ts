/**
 * What a message that points elsewhere borrows for the memory search of its turn.
 *
 * Constructs covered:
 * - A referring reply borrows the message it answers: from the envelope when it carries the text,
 *   otherwise from the conversation's journal.
 * - A short or referring message that answers nothing borrows the few messages before it.
 * - A self-contained message and small talk borrow nothing and read no journal.
 * - Every borrowed line is bounded.
 */
import { describe, expect, it, vi } from "vitest";

import { memoryQueryConversationContext } from "./memory-query-context.js";

// Production, 01.11.2026: the request answered the agent's own list of skills that named pohuy.
const REPLIED = "перепроверила всю ленту, прямого «Осинара, используй pohuy» от Пуха нигде нет";

function source(overrides: Partial<{ previous: string[]; replyText: string | null }> = {}) {
  return {
    previous: vi.fn().mockResolvedValue(overrides.previous ?? ["первое", "второе", "третье"]),
    replyTarget: vi.fn().mockResolvedValue(overrides.replyText === undefined ? REPLIED : overrides.replyText),
  };
}

const CONVERSATION = { conversationId: "conversation-1", sourceSequence: "59976" };

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
    ["small talk", "ахаха"],
  ])("borrows nothing for %s", async (_name, text) => {
    const journal = source();

    await expect(memoryQueryConversationContext(journal, {
      ...CONVERSATION, replyText: null, replyToSequenceId: "59699", text,
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
