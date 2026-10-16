/**
 * Topic messages carry `is_topic_message`; a case pins the ordinary-reply rule.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { describe, expect, it } from "vitest";

import {
  formatTelegramContextBlock,
  parseTelegramUpdate,
} from "./inbound.js";

describe("parseTelegramUpdate", () => {
  it("parses inbound messages with text, actor, reply context, and largest photo", () => {
    const update = parseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        message_thread_id: 7,
        is_topic_message: true,
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        chat: { id: -1001, type: "supergroup", title: "Ops" },
        text: "/ask@testbot hello",
        reply_to_message: {
          message_id: 9,
          from: { id: 99, is_bot: true, username: "testbot" },
          chat: { id: -1001, type: "supergroup", title: "Ops" },
        },
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 10, height: 10, file_size: 100 },
          { file_id: "large", file_unique_id: "u2", width: 20, height: 20, file_size: 400 },
        ],
      },
    });

    expect(update).toMatchObject({
      kind: "message",
      message: {
        messageId: "10",
        messageThreadId: 7,
        text: "/ask@testbot hello",
        chat: { id: "-1001", type: "supergroup", title: "Ops" },
        from: { id: "42", username: "ada" },
        replyToMessage: { messageId: "9", from: { isBot: true } },
        attachments: [{ fileId: "large", kind: "photo", mediaType: "image/jpeg" }],
      },
    });
  });

  it("parses document messages and callback queries", () => {
    const message = parseTelegramUpdate({
      message: {
        message_id: 11,
        chat: { id: 42, type: "private" },
        document: {
          file_id: "doc-id",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 123,
        },
      },
    });
    expect(message).toMatchObject({
      kind: "message",
      message: {
        attachments: [
          {
            fileId: "doc-id",
            fileName: "report.pdf",
            kind: "document",
            mediaType: "application/pdf",
            size: 123,
          },
        ],
      },
    });

    const callback = parseTelegramUpdate({
      callback_query: {
        id: "cb1",
        from: { id: 42, is_bot: false, username: "ada" },
        data: "hitl:0",
        message: {
          message_id: 12,
          chat: { id: 42, type: "private" },
        },
      },
    });
    expect(callback).toMatchObject({
      kind: "callback_query",
      callbackQuery: {
        data: "hitl:0",
        from: { id: "42", username: "ada" },
        id: "cb1",
        message: { messageId: "12", chat: { id: "42" } },
      },
    });
  });

  it("takes a forum topic only from an explicit topic message, not from an ordinary reply", () => {
    const update = parseTelegramUpdate({
      message: {
        message_id: 20,
        message_thread_id: 19,
        chat: { id: -1001, type: "supergroup" },
        text: "reply",
        reply_to_message: { message_id: 19, message_thread_id: 19, chat: { id: -1001, type: "supergroup" } },
      },
    });

    expect(update?.kind).toBe("message");
    if (update?.kind !== "message") return;
    expect(update.message.messageThreadId).toBeUndefined();
    expect(update.message.replyToMessage?.messageThreadId).toBeUndefined();
  });

  it("returns null for unsupported or incomplete updates", () => {
    expect(parseTelegramUpdate({ edited_message: {} })).toBeNull();
    expect(parseTelegramUpdate({ message: { message_id: 1 } })).toBeNull();
  });
});

describe("Telegram context rendering", () => {
  it("carries only what changes from one message to the next", () => {
    // The block is repeated in every turn of the history: constants of the chat cost a few hundred
    // characters each time, and the response rule it once held contradicted the core instructions.
    expect(formatTelegramContextBlock({ messageId: "10", messageThreadId: 7 }))
      .toBe("<telegram_context>\nmessage_id: 10\nmessage_thread_id: 7\n</telegram_context>");
    expect(formatTelegramContextBlock({ messageId: "1" }))
      .toBe("<telegram_context>\nmessage_id: 1\n</telegram_context>");
  });
});
