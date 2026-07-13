/**
 * Telegram dispatch policy tests.
 *
 * Constructs covered:
 * - `isMessageAddressedToBot`: preserves Eve's command semantics and strict mention/reply gating.
 */
import { describe, expect, it } from "vitest";

import { isMessageAddressedToBot } from "./telegram-message-policy.js";

const groupMessage = {
  chat: { id: "-1001", type: "group" as const },
  replyToMessage: undefined,
  text: "обычное сообщение",
};

describe("isMessageAddressedToBot", () => {
  it("accepts every private message", () => {
    expect(
      isMessageAddressedToBot(
        { ...groupMessage, chat: { id: "101", type: "private" } },
        "family_agent",
      ),
    ).toBe(true);
  });

  it("ignores ordinary group conversation", () => {
    expect(isMessageAddressedToBot(groupMessage, "family_agent")).toBe(false);
  });

  it("accepts commands, mentions, and replies to this bot", () => {
    expect(isMessageAddressedToBot({ ...groupMessage, text: "/ask помоги" }, "family_agent")).toBe(
      true,
    );
    expect(
      isMessageAddressedToBot({ ...groupMessage, text: "@family_agent помоги" }, "family_agent"),
    ).toBe(true);
    expect(
      isMessageAddressedToBot(
        {
          ...groupMessage,
          replyToMessage: {
            from: { id: "bot", isBot: true, username: "family_agent" },
          },
        },
        "family_agent",
      ),
    ).toBe(true);
  });

  it("accepts an explicit command suffix only when it targets this bot", () => {
    expect(
      isMessageAddressedToBot({ ...groupMessage, text: "/ask@FAMILY_AGENT помоги" }, "family_agent"),
    ).toBe(true);
    expect(
      isMessageAddressedToBot({ ...groupMessage, text: "/ask@other_bot помоги" }, "family_agent"),
    ).toBe(false);
  });

  it("does not treat an indented command as a Telegram bot command", () => {
    expect(isMessageAddressedToBot({ ...groupMessage, text: "  /ask помоги" }, "family_agent")).toBe(
      false,
    );
  });

  it("does not match this bot username inside another mention", () => {
    expect(
      isMessageAddressedToBot(
        { ...groupMessage, text: "@family_agent_helper помоги" },
        "family_agent",
      ),
    ).toBe(false);
  });

  it("ignores a reply to another bot", () => {
    expect(
      isMessageAddressedToBot(
        {
          ...groupMessage,
          replyToMessage: {
            from: { id: "other-bot", isBot: true, username: "other_bot" },
          },
        },
        "family_agent",
      ),
    ).toBe(false);
  });
});
