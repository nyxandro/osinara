/**
 * Telegram dispatch policy tests.
 *
 * Constructs covered:
 * - `isMessageAddressedToBot`: ignores slash commands and accepts name stems with any suffix.
 * - `telegramGroupTurnTrigger`: names the technical signal that woke the agent in a group.
 * - `classifyTelegramInboundMedia`: recognizes one native photo or allowlisted document candidate.
 * - `hasTelegramInboundMedia`: detects every file-bearing Telegram message kind without download.
 * - `TELEGRAM_EVE_UPLOAD_POLICY`: keeps persisted files out of the text-only primary model.
 */
import {
  buildTelegramTurnMessage,
  collectTelegramFileParts,
} from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import {
  classifyTelegramInboundMedia,
  hasTelegramInboundMedia,
  isMessageAddressedToBot,
  TELEGRAM_EVE_UPLOAD_POLICY,
  telegramGroupTurnTrigger,
} from "./telegram-message-policy.js";

const groupMessage = {
  chat: { id: "-1001", type: "group" as const },
  replyToMessage: undefined,
  text: "обычное сообщение",
};

describe("telegramGroupTurnTrigger", () => {
  const replyToThisBot = {
    from: { id: "bot-1", isBot: true, username: "family_agent" },
  };

  it("reports a private chat and a channel post as having no group trigger", () => {
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, chat: { id: "101", type: "private" }, text: "Осинара, привет" },
      "family_agent",
    )).toBeNull();
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, chat: { id: "-1002", type: "channel" }, text: "@family_agent привет" },
      "family_agent",
    )).toBeNull();
  });

  it("reports ordinary conversation, slash commands and foreign mentions as no trigger", () => {
    expect(telegramGroupTurnTrigger(groupMessage, "family_agent")).toBeNull();
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, text: "/start@family_agent Осинара" },
      "family_agent",
    )).toBeNull();
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, text: "@other_agent помоги" },
      "family_agent",
    )).toBeNull();
  });

  it("names the exact @mention of this bot", () => {
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, text: "@family_agent помоги" },
      "family_agent",
    )).toBe("mention");
  });

  it("names a reply to this bot without any written name", () => {
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, replyToMessage: replyToThisBot, text: "а точнее?" },
      "family_agent",
    )).toBe("reply_to_agent");
  });

  it.each(["Осинара, посчитай смету", "Осинара вчера сказала, что смета готова"])(
    "names a bare agent name in text the same way for an address and a third-person mention: %s",
    (text) => {
      expect(telegramGroupTurnTrigger({ ...groupMessage, text }, "family_agent")).toBe(
        "name_in_text",
      );
    },
  );

  it("prefers the explicit @mention, then the reply, over a bare name", () => {
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, replyToMessage: replyToThisBot, text: "@family_agent Осинара, а точнее?" },
      "family_agent",
    )).toBe("mention");
    expect(telegramGroupTurnTrigger(
      { ...groupMessage, replyToMessage: replyToThisBot, text: "Осинара, а точнее?" },
      "family_agent",
    )).toBe("reply_to_agent");
  });

  it("ignores a reply to another bot", () => {
    expect(telegramGroupTurnTrigger(
      {
        ...groupMessage,
        replyToMessage: { from: { id: "bot-2", isBot: true, username: "other_agent" } },
        text: "спасибо",
      },
      "family_agent",
    )).toBeNull();
  });
});

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

  it.each([
    "Осинар, посмотри сюда",
    "Асинара молодец",
    "АЗИНАРЕ это понравится",
    "Озинарой удобно пользоваться",
    "Osinar help us",
    "Asinara is useful",
    "Синаара, ответь",
  ])("accepts the agent name variant in ordinary group text: %s", (text) => {
    expect(isMessageAddressedToBot({ ...groupMessage, text }, "family_agent")).toBe(true);
  });

  it.each([
    "осинарочка, глянь",
    "асинарачка, спасибо",
    "озинарка тут?",
    "Осинарушка, помоги",
    "передайте осинарам",
    "осинарами не пользуются",
    "асинарке привет",
    "osinarochka, look",
  ])("accepts any suffix after an agent name stem: %s", (text) => {
    expect(isMessageAddressedToBot({ ...groupMessage, text }, "family_agent")).toBe(true);
  });

  it.each(["семинар начался", "квазиосинара", "квазиосинарочка", "не-осина-растёт"])(
    "does not match a name stem inside another word: %s",
    (text) => {
      expect(isMessageAddressedToBot({ ...groupMessage, text }, "family_agent")).toBe(false);
    },
  );

  it("accepts mentions and replies to this bot", () => {
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

  it.each(["/ask помоги", "/clear", "/clear 😁", "/ask@FAMILY_AGENT помоги", "/ask@other_bot помоги"])(
    "does not treat an application-unsupported slash command as an address: %s",
    (text) => {
      expect(isMessageAddressedToBot({ ...groupMessage, text }, "family_agent")).toBe(false);
    },
  );

  it("does not let a reply route turn an unsupported slash command into an address", () => {
    expect(isMessageAddressedToBot({
      ...groupMessage,
      replyToMessage: {
        from: { id: "bot", isBot: true, username: "family_agent" },
      },
      text: "/clear",
    }, "family_agent")).toBe(false);
  });

  it("does not hide a mention after text that exceeds the Telegram command limit", () => {
    const oversizedCommand = `/${"a".repeat(33)} @family_agent помоги`;

    expect(isMessageAddressedToBot({ ...groupMessage, text: oversizedCommand }, "family_agent"))
      .toBe(true);
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

describe("classifyTelegramInboundMedia", () => {
  const nativePhoto = {
    attachments: [{
      fileId: "telegram-photo-1",
      fileUniqueId: "telegram-photo-unique-1",
      kind: "photo" as const,
      mediaType: "image/jpeg",
    }],
    raw: {
      photo: [{
        file_id: "telegram-photo-1",
        file_unique_id: "telegram-photo-unique-1",
        height: 640,
        width: 640,
      }],
    },
  };

  it("classifies text, one native photo, and unsupported media explicitly", () => {
    expect(classifyTelegramInboundMedia({ attachments: [], raw: { text: "текст" } })).toBe("none");
    expect(classifyTelegramInboundMedia(nativePhoto)).toBe("native_photo");
    expect(classifyTelegramInboundMedia({
      attachments: [{ fileId: "image-document", kind: "document", mediaType: "image/jpeg" }],
      raw: { document: { file_id: "image-document", mime_type: "image/jpeg" } },
    })).toBe("image_document_candidate");
  });

  it.each([
    ["image/png", "scan.bin"],
    ["application/octet-stream", "scan.webp"],
  ])("accepts a single image document candidate declared as %s named %s", (mediaType, fileName) => {
    const message = {
      attachments: [{ fileId: "image-document", fileName, kind: "document" as const, mediaType }],
      raw: {
        document: {
          file_id: "image-document",
          file_name: fileName,
          mime_type: mediaType,
        },
      },
    };

    expect(classifyTelegramInboundMedia(message)).toBe("image_document_candidate");
  });

  it("rejects a document without an image declaration or recognized static image extension", () => {
    expect(classifyTelegramInboundMedia({
      attachments: [{
        fileId: "document",
        fileName: "report.pdf",
        kind: "document",
        mediaType: "application/pdf",
      }],
      raw: { document: { file_id: "document", file_name: "report.pdf", mime_type: "application/pdf" } },
    })).toBe("unsupported_media");
  });

  it.each([
    ["text/plain", "notes.txt"],
    ["text/markdown", "README.md"],
    ["application/json", "payload.json"],
    ["text/csv", "report.csv"],
    ["text/tab-separated-values", "report.tsv"],
    ["text/html", "PAGE.HTML"],
    ["application/xml", "feed.Xml"],
    ["application/yaml", "settings.YAML"],
    ["application/yaml", "config.yml"],
  ])("classifies a supported text document declared as %s named %s", (mediaType, fileName) => {
    expect(classifyTelegramInboundMedia({
      attachments: [{ fileId: "text-document", fileName, kind: "document", mediaType }],
      raw: {
        document: {
          file_id: "text-document",
          file_name: fileName,
          mime_type: mediaType,
        },
      },
    })).toBe("text_document_candidate");
  });

  it("treats Telegram's spreadsheet declaration as metadata for a CSV candidate", () => {
    expect(classifyTelegramInboundMedia({
      attachments: [{
        fileId: "csv-document",
        fileName: "report.csv",
        kind: "document",
        mediaType: "application/vnd.ms-excel",
      }],
      raw: {
        document: {
          file_id: "csv-document",
          file_name: "report.csv",
          mime_type: "application/vnd.ms-excel",
        },
      },
    })).toBe("text_document_candidate");
  });

  it.each(["report.pdf", "document.docx", "archive.zip"])(
    "does not classify unsupported document %s as readable text",
    (fileName) => {
      expect(classifyTelegramInboundMedia({
        attachments: [{
          fileId: "unsupported-document",
          fileName,
          kind: "document",
          mediaType: "application/octet-stream",
        }],
        raw: {
          document: {
            file_id: "unsupported-document",
            file_name: fileName,
            mime_type: "application/octet-stream",
          },
        },
      })).toBe("unsupported_media");
    },
  );

  it.each([
    { ...nativePhoto, attachments: [] },
    { ...nativePhoto, raw: { photo: [] } },
    { ...nativePhoto, raw: { photo: "malformed" } },
    { ...nativePhoto, raw: { document: { file_id: "mixed" }, ...nativePhoto.raw } },
    {
      ...nativePhoto,
      attachments: [...nativePhoto.attachments, { fileId: "second", kind: "photo" as const }],
    },
  ])("fails closed for mixed or malformed native-photo metadata", (message) => {
    expect(classifyTelegramInboundMedia(message)).toBe("unsupported_media");
  });
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
