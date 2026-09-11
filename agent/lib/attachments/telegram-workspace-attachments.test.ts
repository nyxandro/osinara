/**
 * Telegram-to-workspace attachment ingestion tests.
 *
 * Constructs covered:
 * - `createTelegramWorkspaceAttachmentImporter`: validated persistence before model dispatch.
 * - Deterministic personal/family/group inbox references, binary persistence, and count limits.
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

  it("persists all album files without overwriting repeated filenames", async () => {
    const download = vi.fn().mockImplementation(async (file: TelegramAttachment) => Buffer.from(file.fileId));
    const writeBinary = vi.fn().mockImplementation(async (_auth, file) => ({ ...file, scope: "personal" }));
    const importer = createTelegramWorkspaceAttachmentImporter({ download, writeBinary });
    const files = Array.from({ length: 10 }, (_, index) => ({
      ...attachment, fileId: `file-${index}`, fileUniqueId: `unique-${index}`, fileName: "key.txt",
      telegramMessageId: String(42 + index),
    }));
    const result = await importer.persist({ attachments: files, auth, chatId: "101", messageId: "42", scope: "personal" });
    expect(result).toHaveLength(10);
    expect(new Set(result.map(file => file.path)).size).toBe(10);
    expect(result.map(file => file.telegramMessageId)).toEqual(files.map(file => file.telegramMessageId));
    expect(result.map(file => file.path)).toEqual(files.map(file => `inbox/${file.telegramMessageId}/key.txt`));
    expect(download).toHaveBeenCalledTimes(10);
    expect(writeBinary.mock.calls.map(call => call[1].bytes.toString())).toEqual(files.map(file => file.fileId));
  });

  it("retains two occurrences of the same file under their real Telegram message IDs", async () => {
    const writeBinary = vi.fn().mockImplementation(async (_auth, file) => ({ ...file, scope: "personal" }));
    const importer = createTelegramWorkspaceAttachmentImporter({ download: vi.fn().mockResolvedValue(Buffer.from("same file")), writeBinary });
    const result = await importer.persist({ attachments: [
      { ...attachment, telegramMessageId: "41" }, { ...attachment, telegramMessageId: "42" },
    ], auth, chatId: "101", messageId: "42", scope: "personal" });
    expect(result.map(file => file.telegramMessageId)).toEqual(["41", "42"]);
    expect(writeBinary.mock.calls.map(call => call[1].operationKey)).toEqual([
      "telegram-attachment:101:41:unique-file-id", "telegram-attachment:101:42:unique-file-id",
    ]);
  });

  it("rejects a multi-file import missing individual source identities before downloading", async () => {
    const download = vi.fn();
    const importer = createTelegramWorkspaceAttachmentImporter({ download, writeBinary: vi.fn() });
    await expect(importer.persist({ attachments: [attachment, attachment], auth, chatId: "101", messageId: "42", scope: "personal" }))
      .rejects.toThrow(/AGENT_ATTACHMENT_SOURCE_MISSING/);
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects an oversized album before downloading", async () => {
    const download = vi.fn();
    const importer = createTelegramWorkspaceAttachmentImporter({
      download,
      writeBinary: vi.fn(),
    });

    await expect(importer.persist({
      attachments: Array.from({ length: 11 }, (_, index) => ({ ...attachment, fileId: `file-${index}` })),
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

  it("persists only readable UTF-8 text in an external group workspace inbox", async () => {
    const bytes = Buffer.from("# Group notes\n\nDecision: ship safely.\n", "utf8");
    const groupAuth = {
      ...auth,
      groupId: "00000000-0000-4000-8000-000000000456",
      groupType: "external" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };
    const writeBinary = vi.fn().mockResolvedValue({
      byteSize: bytes.byteLength,
      contentSha256: "d".repeat(64),
      mediaType: "text/markdown",
      path: "inbox/45/notes.md",
      scope: "group",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn().mockResolvedValue(bytes),
      writeBinary,
    });

    await importer.persist({
      attachments: [{
        fileId: "text-file",
        fileName: "notes.md",
        fileUniqueId: "text-id",
        kind: "document",
        mediaType: "text/markdown",
      }],
      auth: groupAuth,
      chatId: "-100456",
      messageId: "45",
      scope: "group",
    });

    expect(writeBinary).toHaveBeenCalledWith(groupAuth, expect.objectContaining({
      mediaType: "text/markdown",
      path: "inbox/45/notes.md",
      scope: "group",
    }));
  });

  it("rejects binary bytes disguised as external text before persistence", async () => {
    const writeBinary = vi.fn();
    const groupAuth = {
      ...auth,
      groupId: "00000000-0000-4000-8000-000000000456",
      groupType: "external" as const,
      role: "external" as const,
      telegramChatType: "supergroup" as const,
      userId: null,
    };
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn().mockResolvedValue(Buffer.from([0x00, 0xff, 0x01])),
      writeBinary,
    });

    await expect(importer.persist({
      attachments: [{
        fileId: "binary-file",
        fileName: "notes.txt",
        kind: "document",
        mediaType: "text/plain",
      }],
      auth: groupAuth,
      chatId: "-100456",
      messageId: "46",
      scope: "group",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_TEXT_REQUIRED/u);
    expect(writeBinary).not.toHaveBeenCalled();
  });
});
