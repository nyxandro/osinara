/**
 * Telegram attachment download tests.
 *
 * Constructs covered:
 * - `createTelegramAttachmentDownloader`: declared and actual 20 MB download limits.
 * - Telegram getFile/download response validation.
 * - Transport and response-body failures return a bounded correction contract.
 * - An attempt that stalls past its deadline or loses its connection is repeated once (#498 for
 *   voice, 16.11.2026 for photos and files: Telegram held `getFile` for two minutes, then answered
 *   504); Telegram's error answer and an oversized file are not repeated.
 */
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramAttachmentDownloader, downloadTelegramAttachment } from "./telegram-attachment-download.js";

const ATTEMPTS = { attemptTimeoutMs: 50, attempts: 2 } as const;

/** A Telegram request that never answers: it ends only when the attempt's deadline aborts it. */
function stalled(_input: string, signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const attachment = (size: number): TelegramAttachment => ({
  fileId: "file-id",
  fileName: "notes.txt",
  kind: "document",
  mediaType: "text/plain",
  size,
});

describe("createTelegramAttachmentDownloader", () => {
  it("downloads an accepted file through the runtime's Telegram API", async () => {
    const getFile = vi.fn().mockResolvedValue({ filePath: "documents/file.txt" });
    const downloadFile = vi.fn().mockResolvedValue(new Response("content", { status: 200 }));
    const download = createTelegramAttachmentDownloader({ ...ATTEMPTS, downloadFile, getFile });

    await expect(download(attachment(7))).resolves.toEqual(Buffer.from("content"));
    expect(getFile).toHaveBeenCalledWith("file-id", expect.any(AbortSignal));
    expect(downloadFile).toHaveBeenCalledWith("documents/file.txt", expect.any(AbortSignal));
  });

  it("rejects declared oversized input before any provider call", async () => {
    const getFile = vi.fn();
    const download = createTelegramAttachmentDownloader({
      ...ATTEMPTS,
      downloadFile: vi.fn(),
      getFile,
    });

    await expect(download(attachment(20 * 1024 * 1024 + 1)))
      .rejects.toThrowError(/AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("normalizes Telegram transport failures and asks for a fresh attachment", async () => {
    const getFile = vi.fn().mockRejectedValue(new Error("socket 10.0.0.7 closed"));
    const download = createTelegramAttachmentDownloader({
      ...ATTEMPTS,
      downloadFile: vi.fn(),
      getFile,
    });

    await expect(download(attachment(7))).rejects.toMatchObject({
      contract: {
        code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
        retryable: false,
        sideEffectStatus: "not_started",
      },
    });
    await expect(download(attachment(7))).rejects.not.toThrow(/10\.0\.0\.7/u);
    // Not a stall and not a dropped connection: nothing says a repeat would fare better.
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it("normalizes a response-body stream failure", async () => {
    const response = new Response("content", { status: 200 });
    vi.spyOn(response, "arrayBuffer").mockRejectedValue(new Error("socket 10.0.0.8 closed"));
    const download = createTelegramAttachmentDownloader({
      ...ATTEMPTS,
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

describe("a stalled or dropped attempt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is repeated once when Telegram holds the file metadata past the deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getFile = vi.fn()
      .mockImplementationOnce(stalled)
      .mockResolvedValueOnce({ filePath: "photos/file.jpg" });
    const downloadFile = vi.fn().mockResolvedValue(new Response("photo", { status: 200 }));
    const download = createTelegramAttachmentDownloader({ ...ATTEMPTS, downloadFile, getFile });

    await expect(download(attachment(5))).resolves.toEqual(Buffer.from("photo"));
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({
      attempt: 1,
      code: "AGENT_ATTACHMENT_DOWNLOAD_RETRIED",
      kind: "document",
    });
  });

  it("is repeated once when the connection drops during the download", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getFile = vi.fn().mockResolvedValue({ filePath: "documents/file.txt" });
    const downloadFile = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("content", { status: 200 }));
    const download = createTelegramAttachmentDownloader({ ...ATTEMPTS, downloadFile, getFile });

    await expect(download(attachment(7))).resolves.toEqual(Buffer.from("content"));
    expect(downloadFile).toHaveBeenCalledTimes(2);
  });

  it("asks for a fresh attachment after the last attempt stalls too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getFile = vi.fn().mockImplementation(stalled);
    const download = createTelegramAttachmentDownloader({ ...ATTEMPTS, downloadFile: vi.fn(), getFile });

    await expect(download(attachment(7))).rejects.toMatchObject({
      contract: { code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED", retryable: false, sideEffectStatus: "not_started" },
    });
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
  });

  it("is repeated once when the body is cut off half-way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cutOff = new Response("partial", { status: 200 });
    vi.spyOn(cutOff, "arrayBuffer").mockRejectedValue(new TypeError("terminated"));
    const getFile = vi.fn().mockResolvedValue({ filePath: "photos/file.jpg" });
    const downloadFile = vi.fn()
      .mockResolvedValueOnce(cutOff)
      .mockResolvedValueOnce(new Response("photo", { status: 200 }));
    const download = createTelegramAttachmentDownloader({ ...ATTEMPTS, downloadFile, getFile });

    await expect(download(attachment(5))).resolves.toEqual(Buffer.from("photo"));
    expect(downloadFile).toHaveBeenCalledTimes(2);
  });

  it("does not repeat Telegram's error answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const downloadFile = vi.fn().mockResolvedValue(new Response("gone", { status: 404 }));
    const download = createTelegramAttachmentDownloader({
      ...ATTEMPTS,
      downloadFile,
      getFile: vi.fn().mockResolvedValue({ filePath: "documents/file.txt" }),
    });

    await expect(download(attachment(7))).rejects.toThrowError(/AGENT_ATTACHMENT_DOWNLOAD_FAILED/);
    expect(downloadFile).toHaveBeenCalledOnce();
  });
});

describe("downloadTelegramAttachment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // The production binding must pass the bot token: the runtime's Telegram API has no environment fallback.
  it("downloads the file from Telegram with the configured bot token", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:test-token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"file_path":"documents/file.txt"}}', { status: 200 }))
      .mockResolvedValueOnce(new Response("content", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadTelegramAttachment(attachment(7))).resolves.toEqual(Buffer.from("content"));

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.telegram.org/bot123:test-token/getFile",
      "https://api.telegram.org/file/bot123:test-token/documents/file.txt",
    ]);
    // Without the attempt's signal a stalled Telegram request would wait for minutes again (16.11.2026).
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
  });
});
