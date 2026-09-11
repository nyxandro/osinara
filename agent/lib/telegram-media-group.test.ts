import { describe, expect, it } from "vitest";
import { combineTelegramMediaGroup, privateTelegramMediaGroupKey } from "./telegram-media-group.js";

function albumPayload(id: number, caption = "", chatId = 101, groupId = "album-1") {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1789090000,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "Owner" },
      media_group_id: groupId,
      caption,
      document: { file_id: `file-${id}`, file_unique_id: `unique-${id}`, file_name: `${id}.txt` },
    },
  };
}

describe("private Telegram media groups", () => {
  it("passes all four attachments and the last caption in one native message", () => {
    const payloads = [1, 2, 3, 4].map(id => albumPayload(id, id === 4 ? "Проверь оба сервера" : ""));
    const result = combineTelegramMediaGroup(payloads);
    expect(result.kind).toBe("message");
    if (result.kind !== "message") throw new Error("Expected message");
    expect(result.message.caption).toBe("Проверь оба сервера");
    expect(result.message.messageId).toBe("4");
    expect(result.message.attachments.map(file => file.fileId)).toEqual(["file-1", "file-2", "file-3", "file-4"]);
    expect(payloads[0]!.message.caption).toBe("");
    expect(result.message.raw).toEqual(payloads[3]!.message);
  });

  it("preserves distinct captions in message order and handles captionless photos", () => {
    expect(combineTelegramMediaGroup([albumPayload(1, "Первое"), albumPayload(2, "Второе")]))
      .toMatchObject({ message: { caption: "Первое\n\nВторое" } });
    const photos = [1, 2].map(id => {
      const { document, ...message } = albumPayload(id).message;
      return { update_id: id, message: { ...message, photo: [{ file_id: document.file_id, width: 10, height: 10 }] } };
    });
    expect(combineTelegramMediaGroup(photos)).toMatchObject({ message: { caption: "", attachments: [{ kind: "photo" }, { kind: "photo" }] } });
  });

  it("persists an unsupported album member before rejecting composition, so Telegram retries do not loop", () => {
    const { document, ...message } = albumPayload(1).message;
    const payload = { update_id: 1, message: { ...message, video: { file_id: document.file_id } } };
    expect(privateTelegramMediaGroupKey(payload)).toBe("album-1");
    expect(() => combineTelegramMediaGroup([payload])).toThrow(/AGENT_TELEGRAM_MEDIA_GROUP_INVALID/);
  });

  it.each([
    [albumPayload(1), albumPayload(2, "", 202)],
    [albumPayload(1), albumPayload(2, "", 101, "another-album")],
    [albumPayload(1), { ...albumPayload(2), message: { ...albumPayload(2).message, from: { id: 202, is_bot: false } } }],
    [albumPayload(1), { ...albumPayload(2), message: { ...albumPayload(2).message, is_topic_message: true, message_thread_id: 5 } }],
  ])("rejects mismatched verified identities or group keys", (...payloads) => {
    expect(() => combineTelegramMediaGroup(payloads)).toThrow(/AGENT_TELEGRAM_MEDIA_GROUP_INVALID/);
  });
});
