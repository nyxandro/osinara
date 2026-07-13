/**
 * Telegram-to-workspace attachment ingestion tests.
 *
 * Constructs covered:
 * - `createTelegramWorkspaceAttachmentImporter`: validated persistence before model dispatch.
 * - Deterministic inbox references, arbitrary binary persistence, and count limits.
 */
import type { TelegramAttachment } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramWorkspaceAttachmentImporter } from "./telegram-workspace-attachments.js";

const auth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  groupId: null,
  groupType: null,
  role: "owner" as const,
  telegramChatType: "private" as const,
  userId: "00000000-0000-4000-8000-000000000002",
};

const attachment: TelegramAttachment = {
  fileId: "telegram-file-id",
  fileName: "Семейный бюджет.csv",
  fileUniqueId: "unique-file-id",
  kind: "document",
  mediaType: "text/csv",
  size: 20,
};

describe("createTelegramWorkspaceAttachmentImporter", () => {
  it("validates and persists an authorized private attachment in personal inbox", async () => {
    const bytes = Buffer.from("name,value\nчай,2\n", "utf8");
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "a".repeat(64),
      id: "file-1",
      mediaType: "text/csv",
      path: "inbox/42/Семейный бюджет.csv",
      scope: "personal",
      updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    const result = await importer.persist({
      attachments: [attachment],
      auth,
      chatId: "101",
      messageId: "42",
      scope: "personal",
    });

    expect(result).toMatchObject([{
      mediaType: "text/csv",
      path: "inbox/42/Семейный бюджет.csv",
      scope: "personal",
      telegramMessageId: "42",
    }]);
    expect(writeBinary).toHaveBeenCalledWith(auth, {
      bytes,
      mediaType: "text/csv",
      operationKey: "telegram-attachment:101:42:unique-file-id",
      path: "inbox/42/Семейный бюджет.csv",
      scope: "personal",
    });
  });

  it("rejects an impossible multi-attachment message before downloading", async () => {
    const download = vi.fn();
    const importer = createTelegramWorkspaceAttachmentImporter({
      download,
      writeBinary: vi.fn(),
    });

    await expect(importer.persist({
      attachments: [attachment, { ...attachment, fileId: "second" }],
      auth,
      chatId: "101",
      messageId: "42",
      scope: "personal",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_COUNT_EXCEEDED/);
    expect(download).not.toHaveBeenCalled();
  });

  it("persists an unnamed opaque document under a stable Telegram-derived name", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "b".repeat(64),
      id: "file-opaque",
      mediaType: "application/octet-stream",
      path: "inbox/43/document-opaque-id",
      scope: "personal",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    await expect(importer.persist({
      attachments: [{
        fileId: "opaque-file-id",
        fileUniqueId: "opaque-id",
        kind: "document",
        mediaType: "application/octet-stream",
      }],
      auth,
      chatId: "101",
      messageId: "43",
      scope: "personal",
    })).resolves.toEqual([{
      mediaType: "application/octet-stream",
      path: "inbox/43/document-opaque-id",
      scope: "personal",
      telegramMessageId: "43",
    }]);
    expect(writeBinary).toHaveBeenCalledWith(auth, expect.objectContaining({
      mediaType: "application/octet-stream",
      path: "inbox/43/document-opaque-id",
    }));
  });

  it("isolates a family attachment by its trusted Telegram group", async () => {
    const bytes = Buffer.from("family file", "utf8");
    const familyAuth = {
      ...auth,
      groupId: "00000000-0000-4000-8000-000000000123",
      groupType: "family_private" as const,
      telegramChatType: "group" as const,
    };
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "c".repeat(64),
      mediaType: "application/octet-stream",
      path: "inbox/groups/00000000-0000-4000-8000-000000000123/44/archive.custom",
      scope: "family",
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    await importer.persist({
      attachments: [{ ...attachment, fileName: "archive.custom" }],
      auth: familyAuth,
      chatId: "-100123",
      messageId: "44",
      scope: "family",
    });

    expect(writeBinary).toHaveBeenCalledWith(familyAuth, expect.objectContaining({
      path: "inbox/groups/00000000-0000-4000-8000-000000000123/44/archive.custom",
      scope: "family",
    }));
  });
});
