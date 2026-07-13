/**
 * Telegram dispatch policy tests.
 *
 * Constructs covered:
 * - `isMessageAddressedToBot`: preserves Eve's command semantics and strict mention/reply gating.
 * - `hasTelegramInboundMedia`: detects every file-bearing Telegram message kind without download.
 * - `TELEGRAM_EVE_UPLOAD_POLICY`: keeps persisted files out of the text-only primary model.
 */
import {
  buildTelegramTurnMessage,
  collectTelegramFileParts,
} from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import {
  hasTelegramInboundMedia,
  isMessageAddressedToBot,
  TELEGRAM_EVE_UPLOAD_POLICY,
} from "./telegram-message-policy.js";

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

describe("hasTelegramInboundMedia", () => {
  it.each([
    "animation",
    "audio",
    "chat_shared",
    "document",
    "game",
    "gift",
    "live_photo",
    "new_chat_photo",
    "paid_media",
    "passport_data",
    "photo",
    "poll",
    "rich_message",
    "sticker",
    "story",
    "unique_gift",
    "users_shared",
    "video",
    "video_note",
    "voice",
  ])("detects the Telegram %s field before any file download", (field) => {
    expect(hasTelegramInboundMedia({
      attachments: [],
      raw: { [field]: { file_id: "telegram-file-1" } },
    })).toBe(true);
  });

  it("also detects Eve-parsed attachments and permits text-only messages", () => {
    expect(hasTelegramInboundMedia({
      attachments: [{ fileId: "telegram-file-1", kind: "photo" }],
      raw: {},
    })).toBe(true);
    expect(hasTelegramInboundMedia({ attachments: [], raw: { text: "обычный текст" } })).toBe(
      false,
    );
  });

  it.each(["chat_shared", "poll", "rich_message", "users_shared"])(
    "permits a text-only %s object without Telegram file references",
    (field) => {
      expect(hasTelegramInboundMedia({
        attachments: [],
        raw: { [field]: { text: "только текст" } },
      })).toBe(false);
    },
  );
});

describe("TELEGRAM_EVE_UPLOAD_POLICY", () => {
  it("keeps a Telegram photo out of the primary model while preserving its caption", () => {
    const fileParts = collectTelegramFileParts([{
      fileId: "telegram-photo-1",
      fileName: "photo.jpg",
      kind: "photo",
      mediaType: "image/jpeg",
      size: 1_024,
    }], TELEGRAM_EVE_UPLOAD_POLICY);

    expect(fileParts).toEqual([]);
    expect(buildTelegramTurnMessage({ caption: "Что изображено?", text: "" }, fileParts)).toBe(
      "Что изображено?",
    );
  });
});
