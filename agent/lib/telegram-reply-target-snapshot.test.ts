/**
 * Verified Telegram reply-target projection tests.
 *
 * Constructs covered:
 * - `telegramReplyTargetProjection`: full target text, its author, and the highlighted fragment.
 * - A target is admitted only from the chat the current turn belongs to.
 * - A refused target leaves one structured record and never reaches the turn.
 */
import type { TelegramMessage } from "eve/channels/telegram";
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
