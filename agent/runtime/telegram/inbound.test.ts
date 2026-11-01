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

  // A sticker, a GIF, a video, a video note or a song cover reaches vision through a still: the
  // message keeps exactly one attachment, so the still stands in for the file.
  it.each([
    ["a static sticker as its own WEBP", { sticker: { emoji: "😂", file_id: "sticker-file", file_unique_id: "s1", height: 512, is_animated: false, is_video: false, thumbnail: { file_id: "sticker-thumb", file_unique_id: "t1", height: 128, width: 128 }, type: "regular", width: 512 } },
      { fileId: "sticker-file", fileName: "sticker.webp", fileUniqueId: "s1", height: 512, kind: "photo", mediaType: "image/webp", width: 512 }],
    ["an animated sticker as its preview", { sticker: { file_id: "tgs-file", file_unique_id: "s2", height: 512, is_animated: true, is_video: false, thumbnail: { file_id: "tgs-thumb", file_unique_id: "t2", height: 128, width: 128 }, type: "regular", width: 512 } },
      { fileId: "tgs-thumb", fileName: "preview.jpg", fileUniqueId: "t2", height: 128, kind: "photo", mediaType: "image/jpeg", width: 128 }],
    ["a GIF as its preview instead of the MP4 document", {
      animation: { duration: 3, file_id: "gif-file", file_unique_id: "g1", height: 240, thumbnail: { file_id: "gif-thumb", file_unique_id: "t3", file_size: 900, height: 90, width: 160 }, width: 320 },
      document: { file_id: "gif-file", file_unique_id: "g1", mime_type: "video/mp4" },
    }, { fileId: "gif-thumb", fileName: "preview.jpg", fileUniqueId: "t3", height: 90, kind: "photo", mediaType: "image/jpeg", size: 900, width: 160 }],
    ["a video note as its preview", { video_note: { duration: 20, file_id: "note-file", file_unique_id: "n1", length: 240, thumbnail: { file_id: "note-thumb", file_unique_id: "t4", height: 240, width: 240 } } },
      { fileId: "note-thumb", fileName: "preview.jpg", fileUniqueId: "t4", height: 240, kind: "photo", mediaType: "image/jpeg", width: 240 }],
    ["a song by its cover", { audio: { duration: 200, file_id: "song-file", file_unique_id: "a1", thumbnail: { file_id: "cover", file_unique_id: "t5", height: 300, width: 300 } } },
      { fileId: "cover", fileName: "preview.jpg", fileUniqueId: "t5", height: 300, kind: "photo", mediaType: "image/jpeg", width: 300 }],
  ])("shows %s", (_name, content, attachment) => {
    const update = parseTelegramUpdate({
      message: { chat: { id: 101, type: "private" }, date: 1, from: { first_name: "Анна", id: 101, is_bot: false }, message_id: 7, ...content },
      update_id: 1,
    });

    expect(update?.kind === "message" ? update.message.attachments : null).toEqual([attachment]);
  });

  it("gives a video without a preview no attachment", () => {
    const update = parseTelegramUpdate({
      message: { chat: { id: 101, type: "private" }, date: 1, message_id: 8, video: { duration: 5, file_id: "v", file_unique_id: "v1", height: 1, width: 1 } },
      update_id: 2,
    });

    expect(update?.kind === "message" ? update.message.attachments : null).toEqual([]);
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
