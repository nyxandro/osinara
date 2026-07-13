/**
 * Telegram-to-workspace attachment ingestion tests.
 *
 * Constructs covered:
 * - `createTelegramWorkspaceAttachmentImporter`: clean original persistence before model dispatch.
 * - Fail-closed malware scanning and deterministic inbox paths.
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
  it("scans and persists an authorized private attachment in personal inbox", async () => {
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
      scan: vi.fn().mockResolvedValue(undefined),
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
    }]);
    expect(writeBinary).toHaveBeenCalledWith(auth, {
      bytes,
      mediaType: "text/csv",
      operationKey: "telegram-attachment:101:42:unique-file-id",
      path: "inbox/42/Семейный бюджет.csv",
      scope: "personal",
    });
  });

  it("does not persist bytes when malware scanning rejects them", async () => {
    const writeBinary = vi.fn();
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: vi.fn().mockResolvedValue(Buffer.from("infected", "utf8")),
      scan: vi.fn().mockRejectedValue(new Error("AGENT_ATTACHMENT_MALWARE_DETECTED")),
      writeBinary,
    });

    await expect(importer.persist({
      attachments: [attachment],
      auth,
      chatId: "101",
      messageId: "42",
      scope: "personal",
    })).rejects.toThrowError(/AGENT_ATTACHMENT_MALWARE_DETECTED/);
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it("rejects an impossible multi-attachment message before downloading", async () => {
    const download = vi.fn();
    const importer = createTelegramWorkspaceAttachmentImporter({
      download,
      scan: vi.fn(),
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
});
