/**
 * Telegram group message storage semantic tests.
 *
 * Constructs covered:
 * - `telegramForumTopicId`: distinguishes real forum topics from ordinary reply threads.
 * - Secret text keeps a logical event but never enters durable timeline content.
 * - `telegramDisplayText` / `telegramMessageContent`: what the model and the journal read for a
 *   message — a forward note, the description of non-text content, then the person's own words —
 *   while `telegramInboundText` keeps only those words for routing.
 * - `telegramMessageKind`: every content kind is named, the rare ones included.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { describe, expect, it } from "vitest";

import {
  telegramDisplayText,
  telegramForumTopicId,
  telegramInboundText,
  telegramMessageContent,
  telegramMessageKind,
} from "./telegram-group-message-storage.js";

function message(input: { isTopicMessage?: boolean; threadId?: number }): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false },
    messageId: "10",
    ...(input.threadId === undefined ? {} : { messageThreadId: input.threadId }),
    raw: {
      date: 1_700_000_000,
      ...(input.isTopicMessage === undefined
        ? {}
        : { is_topic_message: input.isTopicMessage }),
    },
    text: "сообщение",
  };
}

describe("telegramForumTopicId", () => {
  it("redacts credentials from durable timeline content", () => {
    expect(telegramMessageContent({
      ...message({}),
      text: "Пароль: correct-horse-battery-staple",
    })).toBeNull();
  });

  it("ignores a delivery thread on an ordinary supergroup reply", () => {
    expect(telegramForumTopicId(message({ threadId: 310 }))).toBeNull();
  });

  it("returns the verified topic ID for a forum message", () => {
    expect(telegramForumTopicId(message({ isTopicMessage: true, threadId: 42 }))).toBe("42");
  });

  it("fails when Telegram marks a forum message without a topic ID", () => {
    expect(() => telegramForumTopicId(message({ isTopicMessage: true }))).toThrow(
      "AGENT_TELEGRAM_MESSAGE_INVALID",
    );
  });
});

describe("what the model and the journal read for a message", () => {
  it("records a place as its description, not as an empty message (production, 31.10.2026)", () => {
    const venue = {
      ...message({}),
      raw: { date: 1, venue: { address: "Ленина Ул., д. 12", location: { latitude: 52.424577, longitude: 37.608176 }, title: "Чашка" } },
      text: "",
    };

    expect(telegramMessageContent(venue)).toBe("📍 Место «Чашка», Ленина Ул., д. 12 — 52.424577, 37.608176");
    expect(telegramMessageKind(venue)).toBe("venue");
    expect(telegramInboundText(venue)).toBe("");
  });

  it("puts the forward note first and the person's own words after the description", () => {
    const forwardedVideo = {
      ...message({}),
      caption: "смотри что нашёл",
      raw: {
        date: 1,
        forward_origin: { chat: { id: 1, title: "Новости", type: "channel" }, date: 1_793_000_000, message_id: 5, type: "channel" },
        video: { duration: 15, file_id: "f", file_unique_id: "u", height: 1, width: 1 },
      },
      text: "",
    };

    expect(telegramDisplayText(forwardedVideo)).toBe("↪ Переслано из канала «Новости», 2026-10-26\n[видео 0:15]\nсмотри что нашёл");
    // Routing reads only what the person wrote: a forwarded command or a note never addresses the bot.
    expect(telegramInboundText(forwardedVideo)).toBe("смотри что нашёл");
  });

  it.each(["checklist", "story", "paid_media", "gift", "unique_gift", "giveaway", "invoice", "live_photo"])(
    "names a %s message by its kind",
    (kind) => {
      expect(telegramMessageKind({ ...message({}), raw: { date: 1, [kind]: {} }, text: "" })).toBe(kind);
    },
  );
});
