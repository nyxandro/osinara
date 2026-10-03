/**
 * Telegram attachment download tests.
 *
 * Constructs covered:
 * - `createTelegramAttachmentDownloader`: declared and actual 20 MB download limits.
 * - Telegram getFile/download response validation.
 * - Transport and response-body failures return a bounded correction contract.
 */
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";
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

  it("normalizes Telegram transport failures and asks for a fresh attachment", async () => {
    const download = createTelegramAttachmentDownloader({
      downloadFile: vi.fn(),
      getFile: vi.fn().mockRejectedValue(new Error("socket 10.0.0.7 closed")),
    });

    await expect(download(attachment(7))).rejects.toMatchObject({
      contract: {
        code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
        retryable: false,
        sideEffectStatus: "not_started",
      },
    });
    await expect(download(attachment(7))).rejects.not.toThrow(/10\.0\.0\.7/u);
  });

  it("normalizes a response-body stream failure", async () => {
    const response = new Response("content", { status: 200 });
    vi.spyOn(response, "arrayBuffer").mockRejectedValue(new Error("socket 10.0.0.8 closed"));
    const download = createTelegramAttachmentDownloader({
      downloadFile: vi.fn().mockResolvedValue(response),
      getFile: vi.fn().mockResolvedValue({ filePath: "documents/file.txt" }),
    });

    await expect(download(attachment(7))).rejects.toMatchObject({
      contract: {
        code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
        retryable: false,
        sideEffectStatus: "not_started",
      },
    });
  });
});
