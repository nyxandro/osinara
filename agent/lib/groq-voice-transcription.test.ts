/**
 * Groq voice transcription adapter tests.
 *
 * Constructs covered:
 * - `createTelegramVoiceTranscriber`: validates Telegram metadata and downloaded bytes.
 * - Size limits before and during download.
 * - Ogg/Opus content validation before sending data to Groq.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramVoiceTranscriber } from "./groq-voice-transcription.js";

function oggOpusBytes(): Uint8Array {
  return new TextEncoder().encode("OggS\0\0\0\0OpusHead\0voice-data");
}

function dependencies() {
  return {
    downloadFile: vi.fn().mockResolvedValue(
      new Response(Buffer.from(oggOpusBytes()), {
        headers: { "content-length": String(oggOpusBytes().byteLength) },
        status: 200,
      }),
    ),
    getFile: vi.fn().mockResolvedValue({ filePath: "voice/file-1.oga" }),
    maxBytes: 1024,
    transcribe: vi.fn().mockResolvedValue("Распознанный текст"),
  };
}

describe("createTelegramVoiceTranscriber", () => {
  it("downloads a valid Ogg/Opus note and passes its bytes to Groq", async () => {
    const adapter = dependencies();
    const transcribeVoice = createTelegramVoiceTranscriber(adapter);

    await expect(
      transcribeVoice({ fileId: "telegram-file-1", fileSize: 512, mimeType: "audio/ogg" }),
    ).resolves.toBe("Распознанный текст");
    expect(adapter.getFile).toHaveBeenCalledWith("telegram-file-1");
    expect(adapter.downloadFile).toHaveBeenCalledWith("voice/file-1.oga");
    expect(adapter.transcribe).toHaveBeenCalledWith(oggOpusBytes());
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
