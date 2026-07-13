/**
 * Telegram reply-target policy tests.
 *
 * Constructs covered:
 * - `telegramTurnReplyParameters`: binds group output to the verified triggering message.
 * - Private and non-message turns remain unthreaded.
 * - Mismatched channel/auth state fails closed.
 */
import type { TelegramChannelState } from "eve/channels/telegram";
import type { SessionContext } from "eve/context";
import { describe, expect, it } from "vitest";

import { telegramTurnReplyParameters } from "./telegram-reply.js";

function state(chatType: "private" | "supergroup" = "supergroup") {
  return {
    chatId: chatType === "private" ? "101" : "-1001",
    chatType,
  } as TelegramChannelState;
}

function context(attributes: Record<string, unknown>) {
  return {
    session: {
      auth: {
        current: {
          attributes,
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
      },
    },
  } as unknown as SessionContext;
}

describe("telegramTurnReplyParameters", () => {
  it("replies to the verified message that triggered a group turn", () => {
    expect(telegramTurnReplyParameters(state(), context({
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramReplyToMessageId: "77",
    }))).toEqual({ allow_sending_without_reply: true, message_id: 77 });
  });

  it("does not add reply metadata to private or callback-originated turns", () => {
    expect(telegramTurnReplyParameters(state("private"), context({
      telegramChatId: "101",
      telegramChatType: "private",
      telegramReplyToMessageId: "77",
    }))).toBeUndefined();
    expect(telegramTurnReplyParameters(state(), context({
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
    }))).toBeUndefined();
  });

  it("rejects a reply target copied from another Telegram chat", () => {
    expect(() => telegramTurnReplyParameters(state(), context({
      telegramChatId: "-1002",
      telegramChatType: "supergroup",
      telegramReplyToMessageId: "77",
    }))).toThrow("AGENT_TELEGRAM_REPLY_CONTEXT_INVALID");
  });
});
