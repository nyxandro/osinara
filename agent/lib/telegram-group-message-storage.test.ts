/**
 * Telegram group message storage semantic tests.
 *
 * Constructs covered:
 * - `telegramForumTopicId`: distinguishes real forum topics from ordinary reply threads.
 * - Secret text keeps a logical event but never enters durable timeline content.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { describe, expect, it } from "vitest";

import {
  telegramForumTopicId,
  telegramMessageContent,
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
