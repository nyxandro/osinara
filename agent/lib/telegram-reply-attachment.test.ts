/**
 * Verified Telegram reply attachment extraction tests.
 *
 * Constructs covered:
 * - External replies expose supported text-document candidates without accepting binary documents.
 * - Exact chat binding prevents a nested reply payload from selecting another group's attachment.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { describe, expect, it } from "vitest";

import type { RegisteredGroup } from "./family-access.js";
import { telegramReplyAttachmentTarget } from "./telegram-reply-attachment.js";

const group: RegisteredGroup = {
  familyId: "family-1",
  groupId: "group-1",
  messageMode: "addressed_only",
  skillAllowlist: [],
  telegramChatId: "-1001",
  toolAllowlist: ["import_telegram_attachment"],
  type: "external",
};

function currentReply(fileName: string, targetChatId = -1001): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1001", title: "Внешняя группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false },
    messageId: "42",
    raw: {
      date: 1_700_000_001,
      reply_to_message: {
        chat: { id: targetChatId, title: "Внешняя группа", type: "supergroup" },
        date: 1_700_000_000,
        document: {
          file_id: "telegram-document",
          file_name: fileName,
          mime_type: "application/octet-stream",
        },
        from: { first_name: "Пётр", id: 102, is_bot: false },
        message_id: 41,
      },
    },
    replyToMessage: {
      chat: { id: "-1001", title: "Внешняя группа", type: "supergroup" },
      from: { firstName: "Пётр", id: "102", isBot: false },
      messageId: "41",
    },
    text: "Прочитай этот файл",
  };
}

describe("telegramReplyAttachmentTarget", () => {
  it("returns one supported text-document candidate from the exact external group", () => {
    expect(telegramReplyAttachmentTarget(currentReply("notes.md"), group)).toMatchObject({
      attachments: [{ fileName: "notes.md", kind: "document" }],
      messageId: "41",
    });
  });

  it("rejects an unsupported binary-document candidate", () => {
    expect(telegramReplyAttachmentTarget(currentReply("report.pdf"), group)).toBeNull();
  });

  it("rejects a nested reply attachment from another chat", () => {
    expect(telegramReplyAttachmentTarget(currentReply("notes.txt", -1002), group)).toBeNull();
  });
});
