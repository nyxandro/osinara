/**
 * Telegram attachment download tests.
 *
 * Constructs covered:
 * - `createTelegramAttachmentDownloader`: declared and actual 20 MB download limits.
 * - Telegram getFile/download response validation.
 */
import type { TelegramAttachment } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramAttachmentDownloader } from "./telegram-attachment-download.js";

const attachment = (size: number): TelegramAttachment => ({
  fileId: "file-id",
  fileName: "notes.txt",
  kind: "document",
  mediaType: "text/plain",
  size,
});

describe("createTelegramAttachmentDownloader", () => {
  it("downloads an accepted file through Eve's public Telegram API", async () => {
    const getFile = vi.fn().mockResolvedValue({ filePath: "documents/file.txt" });
    const downloadFile = vi.fn().mockResolvedValue(new Response("content", { status: 200 }));
    const download = createTelegramAttachmentDownloader({ downloadFile, getFile });

    await expect(download(attachment(7))).resolves.toEqual(Buffer.from("content"));
    expect(getFile).toHaveBeenCalledWith("file-id");
    expect(downloadFile).toHaveBeenCalledWith("documents/file.txt");
  });

  it("rejects declared oversized input before any provider call", async () => {
    const getFile = vi.fn();
    const download = createTelegramAttachmentDownloader({
      downloadFile: vi.fn(),
      getFile,
    });

    await expect(download(attachment(20 * 1024 * 1024 + 1)))
      .rejects.toThrowError(/AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE/);
    expect(getFile).not.toHaveBeenCalled();
  });
});
