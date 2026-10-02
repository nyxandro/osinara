/**
 * External Telegram native-photo authorization tests.
 *
 * Constructs covered:
 * - Live `inspect_workspace_image` policy gates external native photos at `onMessage`.
 * - Authorized native photos and image documents become lazy journal references.
 * - Addressed images never pollute the isolated group workspace.
 * - Revoked, mixed, malformed, and non-image documents fail closed.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { describe, expect, it } from "vitest";

import {
  BOT_USERNAME,
  groupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

function externalPhoto(text: string): TelegramMessage {
  return {
    ...groupMessage(text),
    attachments: [{
      fileId: "telegram-photo-1",
      fileUniqueId: "telegram-photo-unique-1",
      kind: "photo",
      mediaType: "image/jpeg",
      size: 1_024,
    }],
    messageId: "42",
    raw: {
      date: 1_700_000_000,
      photo: [{
        file_id: "telegram-photo-1",
        file_unique_id: "telegram-photo-unique-1",
        height: 640,
        width: 640,
      }],
    },
  };
}

function allowExternalPhoto(repository: ReturnType<typeof repositories>): void {
  repository.telegram.findGroup.mockResolvedValue({
    familyId: "family-1",
    groupId: "group-1",
    messageMode: "addressed_only",
    skillAllowlist: [],
    telegramChatId: "group-101",
    toolAllowlist: ["inspect_workspace_image"],
    type: "external",
  });
}

describe("external Telegram native photos", () => {
  it("captures an unobserved reply image as one exact-group attachment reference", async () => {
    const repository = repositories();
    allowExternalPhoto(repository);
    repository.attachmentReferences.captureReplyTarget.mockResolvedValue({
      attachmentId: "00000000-0000-4000-8000-000000000041",
      kind: "photo",
      mediaType: "image/jpeg",
      telegramMessageId: "41",
    });
    const message: TelegramMessage = {
      ...groupMessage(`@${BOT_USERNAME} что на фото?`),
      messageId: "42",
      raw: {
        date: 1_700_000_001,
        reply_to_message: {
          chat: { id: "group-101", type: "group" },
          date: 1_700_000_000,
          from: { id: "telegram-202", is_bot: false },
          message_id: 41,
          photo: [{ file_id: "reply-photo", file_unique_id: "reply-photo-unique", height: 10, width: 10 }],
        },
      },
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { id: "telegram-202", isBot: false },
        messageId: "41",
      },
    };

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.attachmentReferences.captureReplyTarget).toHaveBeenCalledWith(
      "group-1",
      "00000000-0000-4000-8000-000000000010",
      expect.objectContaining({ messageId: "41" }),
    );
    expect(result?.context?.join("\n")).toContain("00000000-0000-4000-8000-000000000041");
    expect(repository.attachments.persist).not.toHaveBeenCalled();
  });

  it("does not capture a raw reply target bound to another chat", async () => {
    const repository = repositories();
    allowExternalPhoto(repository);
    const message: TelegramMessage = {
      ...groupMessage(`@${BOT_USERNAME} что на фото?`),
      raw: {
        date: 1_700_000_001,
        reply_to_message: {
          chat: { id: "other-group", type: "group" },
          date: 1_700_000_000,
          from: { id: "telegram-202", is_bot: false },
          message_id: 41,
          photo: [{ file_id: "reply-photo", height: 10, width: 10 }],
        },
      },
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { id: "telegram-202", isBot: false },
        messageId: "41",
      },
    };

    await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.attachmentReferences.captureReplyTarget).not.toHaveBeenCalled();
  });

  it("does not expose a reply attachment after external vision capability revocation", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });
    const message: TelegramMessage = {
      ...groupMessage(`@${BOT_USERNAME} что на фото?`),
      raw: {
        date: 1_700_000_001,
        reply_to_message: {
          chat: { id: "group-101", type: "group" },
          date: 1_700_000_000,
          from: { id: "telegram-202", is_bot: false },
          message_id: 41,
          photo: [{ file_id: "reply-photo", height: 10, width: 10 }],
        },
      },
      replyToMessage: {
        chat: { id: "group-101", type: "group" },
        from: { id: "telegram-202", isBot: false },
        messageId: "41",
      },
    };

    await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.attachmentReferences.captureReplyTarget).not.toHaveBeenCalled();
    expect(repository.groupContext.prepare).toHaveBeenCalledWith(expect.objectContaining({
      attachmentReferenceAccess: { images: false, readableText: false },
    }));
  });

  it("records an addressed photo as a lazy reference without workspace persistence", async () => {
    const repository = repositories();
    allowExternalPhoto(repository);
    repository.attachmentReferences.record.mockResolvedValue({
      attachmentId: "00000000-0000-4000-8000-000000000042",
      kind: "photo",
      mediaType: "image/jpeg",
      size: 1_024,
      telegramMessageId: "42",
    });
    const message = externalPhoto(`@${BOT_USERNAME} что изображено?`);

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.attachmentReferences.record).toHaveBeenCalledWith("group-1", message);
    expect(repository.attachments.persist).not.toHaveBeenCalled();
    expect(result?.auth?.attributes).toMatchObject({
      groupId: "group-1",
      toolAllowlist: ["inspect_workspace_image"],
    });
    expect(result?.context?.join("\n")).toContain('"telegramMessageId":"42"');
    expect(result?.context?.join("\n")).toContain("<telegram_attachment_refs>");
  });

  it("journals a nonaddressed photo without downloading it", async () => {
    const repository = repositories();
    allowExternalPhoto(repository);
    const message = externalPhoto("фото для контекста");

    await expect(
      createTelegramMessageHandler(repository)(telegramContext().context, message),
    ).resolves.toBeNull();

    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.attachments.persist).not.toHaveBeenCalled();
    expect(repository.attachmentReferences.record).toHaveBeenCalledWith("group-1", message);
  });

  it("does not download an addressed photo from an unauthorized owner-only sender", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "owner_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: ["inspect_workspace_image"],
      type: "external",
    });
    repository.telegram.findIdentity.mockResolvedValue({
      familyId: "family-1",
      role: "member",
      userId: "user-1",
    });
    const message = externalPhoto(`@${BOT_USERNAME} что изображено?`);

    await expect(
      createTelegramMessageHandler(repository)(telegramContext().context, message),
    ).resolves.toBeNull();

    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-1",
      message,
      expect.objectContaining({ id: "telegram-101", kind: "telegram_user" }),
    );
    expect(repository.attachments.persist).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("rejects a queued photo when live capability policy was revoked before drain", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: [],
      type: "external",
    });

    await expect(createTelegramMessageHandler(repository)(
      telegramContext().context,
      externalPhoto(`@${BOT_USERNAME} что изображено?`),
    )).resolves.toBeNull();

    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.attachments.persist).not.toHaveBeenCalled();
    expect(repository.session.prepareTurn).not.toHaveBeenCalled();
  });

  it("rejects a photo when the persisted external allowlist is partly malformed", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      familyId: "family-1",
      groupId: "group-1",
      messageMode: "addressed_only",
      skillAllowlist: [],
      telegramChatId: "group-101",
      toolAllowlist: ["inspect_workspace_image", "unknown_tool"],
      type: "external",
    });

    await expect(createTelegramMessageHandler(repository)(
      telegramContext().context,
      externalPhoto(`@${BOT_USERNAME} что изображено?`),
    )).resolves.toBeNull();

    expect(repository.journal.record).not.toHaveBeenCalled();
    expect(repository.attachments.persist).not.toHaveBeenCalled();
  });

  it("accepts an image document candidate and rejects mixed media", async () => {
    const repository = repositories();
    allowExternalPhoto(repository);
    const imageDocument: TelegramMessage = {
      ...groupMessage(`@${BOT_USERNAME} что изображено?`),
      attachments: [{
        fileId: "image-document",
        fileName: "photo.jpg",
        kind: "document",
        mediaType: "image/jpeg",
      }],
      raw: { date: 1_700_000_000, document: { file_id: "image-document", mime_type: "image/jpeg" } },
    };
    const mixed = {
      ...externalPhoto(`@${BOT_USERNAME} что изображено?`),
      raw: {
        ...externalPhoto("").raw,
        video: { file_id: "mixed-video" },
      },
    };

    const handler = createTelegramMessageHandler(repository);
    await expect(handler(telegramContext().context, imageDocument)).resolves.not.toBeNull();
    await expect(handler(telegramContext().context, mixed)).resolves.toBeNull();

    expect(repository.attachmentReferences.record).toHaveBeenCalledWith("group-1", imageDocument);
    expect(repository.attachments.persist).not.toHaveBeenCalled();
  });
});
