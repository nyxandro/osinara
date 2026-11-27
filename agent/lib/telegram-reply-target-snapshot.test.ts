/**
 * Verified Telegram reply-target projection tests.
 *
 * Constructs covered:
 * - `telegramReplyTargetProjection`: full target text, its author, and the highlighted fragment.
 * - A rich target and a fragment highlighted in it are read from their rich fields (Bot API 10.4).
 * - A target is admitted only from the chat the current turn belongs to.
 * - A refused target leaves one structured record and never reaches the turn.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { telegramReplyTargetProjection } from "./telegram-reply-target-snapshot.js";

function productionReply(): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1003576522523", title: "Дизраптим AZINO чат", type: "supergroup" },
    from: { firstName: "Пух", id: "136817688", isBot: false },
    messageId: "51002",
    raw: {
      date: 1_786_542_434,
      quote: { text: "streisand" },
      reply_to_message: {
        chat: { id: -1_003_576_522_523, title: "Дизраптим AZINO чат", type: "supergroup" },
        date: 1_786_542_306,
        from: { first_name: "Channel", id: 136_817_688, is_bot: true, username: "Channel_Bot" },
        message_id: 51_001,
        sender_chat: { id: -1_001_823_620_813, title: "nlp_daily", type: "channel", username: "nlp_daily" },
        text: "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
      },
    },
    replyToMessage: {
      chat: { id: "-1003576522523", title: "Дизраптим AZINO чат", type: "supergroup" },
      from: { firstName: "Channel", id: "136817688", isBot: true, username: "Channel_Bot" },
      messageId: "51001",
    },
    text: "@osinara_bot а чо это",
  };
}

/** The same production reply, but its target names a chat the current turn was not authorized for. */
function foreignChatReply(): TelegramMessage {
  const message = productionReply();
  const rawTarget = message.raw.reply_to_message as Record<string, unknown>;
  const foreignChat = { id: "-1009999999999", title: "Другой чат", type: "supergroup" as const };

  return {
    ...message,
    raw: {
      ...message.raw,
      reply_to_message: { ...rawTarget, chat: { ...foreignChat, id: -1_009_999_999_999 } },
    },
    replyToMessage: { ...message.replyToMessage!, chat: foreignChat },
  };
}

/**
 * A reply to a rich message, such as the bot's own formatted answer. Since Bot API 10.4 a fragment
 * highlighted there comes in `quote.rich_texts`, one item per quotable text, and `quote.text` is empty.
 */
function richTargetReply(quote: Record<string, unknown>): TelegramMessage {
  const message = productionReply();
  const { text: _text, ...rawTarget } = message.raw.reply_to_message as Record<string, unknown>;
  return {
    ...message,
    raw: {
      ...message.raw,
      quote,
      reply_to_message: {
        ...rawTarget,
        rich_message: {
          blocks: [
            { text: "Что нового", type: "section_heading" },
            { text: ["Hex 3.5.2: ", { text: "диктовка", type: "bold" }, " теперь по умолчанию"], type: "paragraph" },
          ],
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegramReplyTargetProjection", () => {
  it("extracts the full target, its channel author, and the highlighted fragment", () => {
    expect(telegramReplyTargetProjection(productionReply())).toEqual({
      snapshot: {
        contentText: "У меня настроен vless, ссылочку кинул в streisand, и орка работает на телефоне",
        senderDisplayName: "nlp_daily",
        senderUsername: "nlp_daily",
      },
      quotedText: "streisand",
    });
  });

  it("shows a place the person replied to by its description, not as nothing", () => {
    const message = productionReply();
    const rawTarget = message.raw.reply_to_message as Record<string, unknown>;
    const { text: _text, ...withoutText } = rawTarget;
    const reply = {
      ...message,
      raw: {
        ...message.raw,
        quote: undefined,
        reply_to_message: { ...withoutText, venue: { address: "Ленина ул., 12", location: { latitude: 1, longitude: 2 }, title: "Чашка" } },
      },
    };

    expect(telegramReplyTargetProjection(reply).snapshot?.contentText).toBe("📍 Место «Чашка», Ленина ул., 12 — 1, 2");
  });

  it("reads a fragment highlighted in a rich message, which Telegram sends apart from the quote text", () => {
    const reply = richTargetReply({
      is_manual: true,
      position: 0,
      rich_texts: ["Что нового", ["Hex 3.5.2: ", { text: "диктовка", type: "bold" }, " теперь по умолчанию"]],
      text: "",
    });

    expect(telegramReplyTargetProjection(reply)).toEqual({
      snapshot: {
        contentText: "Что нового\n\nHex 3.5.2: диктовка теперь по умолчанию",
        senderDisplayName: "nlp_daily",
        senderUsername: "nlp_daily",
      },
      quotedText: "Что нового\nHex 3.5.2: диктовка теперь по умолчанию",
    });
  });

  it("prefers the plain quote text when Telegram fills it", () => {
    const reply = richTargetReply({ position: 0, rich_texts: ["другое"], text: "диктовка" });

    expect(telegramReplyTargetProjection(reply).quotedText).toBe("диктовка");
  });

  // A rich answer may be up to 32768 characters, and the whole current-message envelope fits in 12000.
  it("keeps a long rich target and its fragment within Telegram's limits for a message and a quote", () => {
    const message = richTargetReply({ position: 0, rich_texts: ["я".repeat(5_000)], text: "" });
    const rawTarget = message.raw.reply_to_message as Record<string, unknown>;
    const reply = {
      ...message,
      raw: {
        ...message.raw,
        reply_to_message: { ...rawTarget, rich_message: { blocks: [{ text: "ж".repeat(30_000), type: "paragraph" }] } },
      },
    };

    const projection = telegramReplyTargetProjection(reply);

    expect(projection.snapshot?.contentText).toBe(`${"ж".repeat(4_095)}…`);
    expect(projection.quotedText).toBe(`${"я".repeat(1_023)}…`);
  });

  it("reports no fragment when a rich quote carries nothing readable", () => {
    const reply = richTargetReply({ is_manual: true, position: 0, rich_texts: [" "], text: "" });

    expect(telegramReplyTargetProjection(reply).quotedText).toBeNull();
  });

  it("reports no fragment for a whole-message reply", () => {
    const message = productionReply();
    const { quote: _quote, ...raw } = message.raw;

    expect(telegramReplyTargetProjection({ ...message, raw }).quotedText).toBeNull();
  });

  it("reports nothing for an ordinary message that replies to nothing", () => {
    const message = productionReply();
    const { reply_to_message: _target, ...raw } = message.raw;

    expect(telegramReplyTargetProjection({ ...message, raw, replyToMessage: undefined }))
      .toEqual({ snapshot: null, quotedText: null });
  });

  it("admits neither the target text nor the fragment from another chat", () => {
    expect(telegramReplyTargetProjection(foreignChatReply()))
      .toEqual({ snapshot: null, quotedText: null });
  });

  it("rejects a raw target that does not match the parsed reply identity", () => {
    const message = productionReply();
    const raw = message.raw.reply_to_message as Record<string, unknown>;

    expect(telegramReplyTargetProjection({
      ...message,
      raw: { ...message.raw, reply_to_message: { ...raw, message_id: 51_000 } },
    })).toEqual({ snapshot: null, quotedText: null });
  });
});

describe("refused reply target diagnostics", () => {
  it("records the refused foreign chat once, with its stable code", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    telegramReplyTargetProjection(foreignChatReply());

    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logged.mock.calls[0]![0] as string)).toMatchObject({
      code: "AGENT_TELEGRAM_REPLY_TARGET_REJECTED",
      reason: "foreign_chat",
      telegramChatId: "-1003576522523",
      telegramReplyTargetChatId: "-1009999999999",
    });
  });

  it("stays silent for an ordinary message that replies to nothing", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = productionReply();
    const { reply_to_message: _target, ...raw } = message.raw;

    telegramReplyTargetProjection({ ...message, raw, replyToMessage: undefined });

    expect(logged).not.toHaveBeenCalled();
  });
});
