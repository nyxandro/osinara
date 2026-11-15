/**
 * Groq voice transcription adapter tests.
 *
 * Constructs covered:
 * - `createTelegramVoiceTranscriber`: validates Telegram metadata and downloaded bytes.
 * - Size limits before and during download.
 * - Ogg/Opus content validation before sending data to Groq.
 * - One repeat of the Telegram fetch after a stalled or dropped attempt, and a plain failure after.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramVoiceTranscriber, transcribeTelegramVoice } from "./groq-voice-transcription.js";

function oggOpusBytes(): Uint8Array {
  return new TextEncoder().encode("OggS\0\0\0\0OpusHead\0voice-data");
}

function dependencies() {
  return {
    downloadAttemptTimeoutMs: 1_000,
    downloadAttempts: 2,
    downloadFile: vi.fn<(filePath: string, signal: AbortSignal) => Promise<Response>>().mockImplementation(async () =>
      new Response(Buffer.from(oggOpusBytes()), {
        headers: { "content-length": String(oggOpusBytes().byteLength) },
        status: 200,
      })),
    getFile: vi.fn<(fileId: string, signal: AbortSignal) => Promise<{ filePath: string }>>()
      .mockResolvedValue({ filePath: "voice/file-1.oga" }),
    maxBytes: 1024,
    transcribe: vi.fn().mockResolvedValue("Распознанный текст"),
  };
}

/** A Telegram request that never answers, ended only by the signal it was given, as fetch ends it. */
function stalled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A response whose body stops arriving and fails when the signal ends it, as a fetch body does. */
function stalledBody(signal: AbortSignal): Response {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }));
}

describe("createTelegramVoiceTranscriber", () => {
  // A failed assertion must not leave the console spy behind for the next test.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads a valid Ogg/Opus note and passes its bytes to Groq", async () => {
    const adapter = dependencies();
    const transcribeVoice = createTelegramVoiceTranscriber(adapter);

    await expect(
      transcribeVoice({ fileId: "telegram-file-1", fileSize: 512, mimeType: "audio/ogg" }),
    ).resolves.toBe("Распознанный текст");
    expect(adapter.getFile).toHaveBeenCalledWith("telegram-file-1", expect.any(AbortSignal));
    expect(adapter.downloadFile).toHaveBeenCalledWith("voice/file-1.oga", expect.any(AbortSignal));
    expect(adapter.transcribe).toHaveBeenCalledWith(oggOpusBytes(), undefined);
  });

  it("rejects an oversized note before requesting Telegram file metadata", async () => {
    const adapter = dependencies();
    const transcribeVoice = createTelegramVoiceTranscriber(adapter);

    await expect(
      transcribeVoice({ fileId: "telegram-file-1", fileSize: 1025, mimeType: "audio/ogg" }),
    ).rejects.toThrowError(/AGENT_VOICE_FILE_TOO_LARGE/);
    expect(adapter.getFile).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("passes the active cancellation signal through metadata, download and transcription", async () => {
    const adapter = dependencies();
    const controller = new AbortController();
    await createTelegramVoiceTranscriber(adapter)({ fileId: "voice", signal: controller.signal });
    const metadataSignal = adapter.getFile.mock.calls[0]![1];
    const downloadSignal = adapter.downloadFile.mock.calls[0]![1];
    controller.abort(new Error("TEST_TURN_CANCELLED"));
    // The Telegram requests carry their own deadline too, so they get a signal tied to the caller's.
    expect(metadataSignal.aborted).toBe(true);
    expect(downloadSignal.aborted).toBe(true);
    expect(adapter.transcribe).toHaveBeenCalledWith(oggOpusBytes(), controller.signal);
  });

  it("repeats a Telegram request that stalled past its deadline and sends Groq the audio once", async () => {
    const adapter = dependencies();
    adapter.downloadAttemptTimeoutMs = 20;
    adapter.getFile.mockImplementationOnce((_fileId, signal) => stalled(signal));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice", fileSize: 512 }))
      .resolves.toBe("Распознанный текст");
    expect(adapter.getFile).toHaveBeenCalledTimes(2);
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
    // The repeat is visible in the log: it is the only trace of a Telegram path that stalls.
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ code: "AGENT_VOICE_DOWNLOAD_RETRIED", attempt: 1, fileSize: 512 }),
    ]);
  });

  it("repeats a download whose body stopped arriving, within the same deadline", async () => {
    const adapter = dependencies();
    adapter.downloadAttemptTimeoutMs = 20;
    adapter.downloadFile.mockImplementationOnce(async (_filePath, signal) => stalledBody(signal));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice" })).resolves.toBe("Распознанный текст");
    expect(adapter.downloadFile).toHaveBeenCalledTimes(2);
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
  });

  it("repeats a download after the connection to Telegram dropped", async () => {
    const adapter = dependencies();
    adapter.downloadFile.mockRejectedValueOnce(new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice" })).resolves.toBe("Распознанный текст");
    expect(adapter.downloadFile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ cause: "fetch failed", causeCode: "ECONNRESET" });
  });

  it("repeats a download whose body Telegram cut off mid-way", async () => {
    const adapter = dependencies();
    adapter.downloadFile.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("OggS"));
        controller.error(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
      },
    })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice" })).resolves.toBe("Распознанный текст");
    expect(adapter.downloadFile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ cause: "terminated", causeCode: "UND_ERR_SOCKET" });
  });

  it("does not repeat a TypeError that is a defect rather than a lost connection", async () => {
    const adapter = dependencies();
    adapter.getFile.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'file_path')"));

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice" }))
      .rejects.toMatchObject({ code: "AGENT_VOICE_DOWNLOAD_FAILED", cause: expect.any(TypeError) });
    expect(adapter.getFile).toHaveBeenCalledTimes(1);
  });

  it("does not start a third attempt when the caller cancels during the repeat", async () => {
    const adapter = dependencies();
    adapter.downloadAttemptTimeoutMs = 20;
    const controller = new AbortController();
    adapter.getFile
      .mockImplementationOnce((_fileId, signal) => stalled(signal))
      .mockImplementationOnce((_fileId, signal) => {
        queueMicrotask(() => controller.abort(new Error("TEST_LEASE_LOST")));
        return stalled(signal);
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice", signal: controller.signal }))
      .rejects.toThrow("TEST_LEASE_LOST");
    expect(adapter.getFile).toHaveBeenCalledTimes(2);
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("reports a plain download failure, with the last error as its cause, when the repeat stalls too", async () => {
    const adapter = dependencies();
    adapter.downloadAttemptTimeoutMs = 20;
    adapter.getFile.mockImplementation((_fileId, signal) => stalled(signal));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const failure = await createTelegramVoiceTranscriber(adapter)({ fileId: "voice" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "AGENT_VOICE_DOWNLOAD_FAILED",
      message: "AGENT_VOICE_DOWNLOAD_FAILED: Не удалось скачать голосовое сообщение из Telegram. Попробуйте отправить его снова",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(adapter.getFile).toHaveBeenCalledTimes(2);
    // Only the first attempt is followed by a repeat; the second one ends the step.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("does not repeat a request the caller cancelled and passes the caller's reason on", async () => {
    const adapter = dependencies();
    const controller = new AbortController();
    adapter.getFile.mockImplementationOnce((_fileId, signal) => {
      queueMicrotask(() => controller.abort(new Error("TEST_LEASE_LOST")));
      return stalled(signal);
    });

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice", signal: controller.signal }))
      .rejects.toThrow("TEST_LEASE_LOST");
    expect(adapter.getFile).toHaveBeenCalledTimes(1);
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("does not repeat a request Telegram answered with an error, and says the download failed", async () => {
    const adapter = dependencies();
    adapter.getFile.mockRejectedValueOnce(new Error("Telegram getFile failed with HTTP 400."));

    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice" }))
      .rejects.toMatchObject({ code: "AGENT_VOICE_DOWNLOAD_FAILED" });
    expect(adapter.getFile).toHaveBeenCalledTimes(1);

    adapter.downloadFile.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice" }))
      .rejects.toMatchObject({ code: "AGENT_VOICE_DOWNLOAD_FAILED" });
    expect(adapter.downloadFile).toHaveBeenCalledTimes(1);
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("does not start a paid transcription after the request was aborted during download", async () => {
    const adapter = dependencies();
    const controller = new AbortController();
    adapter.downloadFile.mockImplementation(async () => {
      controller.abort(new Error("TEST_VOICE_DEADLINE"));
      return new Response(Buffer.from(oggOpusBytes()));
    });
    await expect(createTelegramVoiceTranscriber(adapter)({ fileId: "voice", signal: controller.signal })).rejects.toThrow("TEST_VOICE_DEADLINE");
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("rejects an unsupported declared media type before downloading the file", async () => {
    const adapter = dependencies();
    const transcribeVoice = createTelegramVoiceTranscriber(adapter);

    await expect(
      transcribeVoice({ fileId: "telegram-file-1", fileSize: 512, mimeType: "audio/mpeg" }),
    ).rejects.toThrowError(/AGENT_VOICE_MEDIA_TYPE_UNSUPPORTED/);
    expect(adapter.getFile).not.toHaveBeenCalled();
  });

  it("rejects content that is not an Ogg/Opus voice note", async () => {
    const adapter = dependencies();
    adapter.downloadFile.mockResolvedValue(
      new Response(Buffer.from(new TextEncoder().encode("not-audio"))),
    );
    const transcribeVoice = createTelegramVoiceTranscriber(adapter);

    await expect(
      transcribeVoice({ fileId: "telegram-file-1", fileSize: 9, mimeType: "audio/ogg" }),
    ).rejects.toThrowError(/AGENT_VOICE_CONTENT_INVALID/);
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("passes a video note's MP4 to Groq and refuses an MP4 claim over other bytes", async () => {
    // An ISO base media file opens with a box size and the `ftyp` box; the AI SDK names it audio/mp4.
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const adapter = dependencies();
    adapter.downloadFile.mockResolvedValueOnce(new Response(mp4));
    const transcribeVoice = createTelegramVoiceTranscriber(adapter);

    await expect(transcribeVoice({ fileId: "note-1", fileSize: mp4.byteLength, mimeType: "video/mp4" })).resolves.toBe("Распознанный текст");
    expect(adapter.transcribe).toHaveBeenCalledWith(new Uint8Array(mp4), undefined);

    adapter.downloadFile.mockResolvedValueOnce(new Response(Buffer.from("OggS-not-mp4")));
    await expect(transcribeVoice({ fileId: "note-2", fileSize: 12, mimeType: "video/mp4" }))
      .rejects.toThrowError(/AGENT_VOICE_CONTENT_INVALID/);
  });

  it("stops reading when the actual response exceeds the configured limit", async () => {
    const adapter = dependencies();
    adapter.maxBytes = 8;
    adapter.downloadFile.mockResolvedValue(new Response(Buffer.from(oggOpusBytes())));
    const transcribeVoice = createTelegramVoiceTranscriber(adapter);

    await expect(
      transcribeVoice({ fileId: "telegram-file-1", mimeType: "audio/ogg" }),
    ).rejects.toThrowError(/AGENT_VOICE_FILE_TOO_LARGE/);
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });
});

describe("transcribeTelegramVoice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // The production binding must pass the bot token: the runtime's Telegram API has no environment fallback.
  it("fetches the voice file from Telegram with the configured bot token", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:test-token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"file_path":"voice/file.oga"}}', { status: 200 }))
      .mockResolvedValueOnce(new Response("not an ogg file", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeTelegramVoice({ fileId: "voice-file-id" }))
      .rejects.toMatchObject({ code: "AGENT_VOICE_CONTENT_INVALID" });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.telegram.org/bot123:test-token/getFile",
      "https://api.telegram.org/file/bot123:test-token/voice/file.oga",
    ]);
    // Without the attempt's signal a stalled Telegram request would never end.
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
