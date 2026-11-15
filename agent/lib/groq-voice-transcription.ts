/**
 * Telegram voice download and Groq transcription adapter.
 *
 * Exports:
 * - `TelegramVoiceFile`: trusted subset of Telegram voice metadata.
 * - `createTelegramVoiceTranscriber`: dependency-injected validation/download pipeline.
 * - `transcribeTelegramVoice`: production Telegram and Groq implementation.
 *
 * Key construct:
 * - The Telegram fetch (metadata, download and body) runs under one deadline per attempt and is
 *   repeated once after a stall or a dropped connection (#498). Groq is called only after the audio
 *   is in, so a repeat never pays for a transcription twice.
 */
import { transcribe } from "ai";
import { downloadTelegramFile, getTelegramFile } from "../runtime/telegram/api.js";

import {
  GROQ_TRANSCRIPTION_TIMEOUT_MS,
  TELEGRAM_VOICE_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
  TELEGRAM_VOICE_DOWNLOAD_ATTEMPTS,
  TELEGRAM_VOICE_MAX_BYTES,
} from "../config.js";
import { AppError, isAppError } from "./app-error.js";
import { voiceTranscriptionModel } from "./model-registry.js";

const OGG_SIGNATURE = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const OPUS_HEAD_SIGNATURE = new TextEncoder().encode("OpusHead");
// An ISO base media file opens with a four-byte box size and the `ftyp` box.
const MP4_FTYP_SIGNATURE = new TextEncoder().encode("ftyp");
const MP4_FTYP_OFFSET = 4;
// A video note is an MP4 with its speech in the audio track; Groq takes it like a voice note.
const VIDEO_NOTE_MEDIA_TYPE = "video/mp4";
const SUPPORTED_VOICE_MEDIA_TYPES = new Set([
  "application/ogg",
  "audio/ogg",
  "audio/opus",
  "audio/x-opus+ogg",
  VIDEO_NOTE_MEDIA_TYPE,
]);
// How Node's fetch reports a lost connection: on the request, and on a body cut off mid-way.
// Any other TypeError is a defect, which a repeat would only hide.
const FETCH_CONNECTION_FAILURE_MESSAGES = new Set(["fetch failed", "terminated"]);

export interface TelegramVoiceFile {
  fileId: string;
  fileSize?: number;
  mimeType?: string;
  signal?: AbortSignal;
}

interface TelegramVoiceTranscriberDependencies {
  /** How long one attempt may take, from the metadata request to the last byte of the file. */
  downloadAttemptTimeoutMs: number;
  /** Attempts in all; only a stalled attempt or a dropped connection leads to the next one. */
  downloadAttempts: number;
  downloadFile(filePath: string, signal: AbortSignal): Promise<Response>;
  getFile(fileId: string, signal: AbortSignal): Promise<{ filePath: string }>;
  maxBytes: number;
  transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<string>;
}

function voiceDownloadFailed(cause?: unknown): AppError {
  return new AppError(
    "AGENT_VOICE_DOWNLOAD_FAILED",
    "Не удалось скачать голосовое сообщение из Telegram. Попробуйте отправить его снова",
    cause === undefined ? undefined : { cause },
  );
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function includesSignature(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) return false;
  for (let start = 0; start <= bytes.byteLength - signature.byteLength; start += 1) {
    if (signature.every((byte, index) => bytes[start + index] === byte)) return true;
  }
  return false;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new AppError(
      "AGENT_VOICE_FILE_TOO_LARGE",
      "Голосовое сообщение превышает допустимый размер. Отправьте более короткую запись",
    );
  }
  if (!response.body) throw voiceDownloadFailed();

  // Read incrementally so an incorrect or absent Content-Length cannot bypass the hard cap.
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let receivedBytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw new AppError(
        "AGENT_VOICE_FILE_TOO_LARGE",
        "Голосовое сообщение превышает допустимый размер. Отправьте более короткую запись",
      );
    }
    chunks.push(chunk.value);
  }

  const audio = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

async function downloadVoiceOnce(
  fileId: string,
  signal: AbortSignal,
  dependencies: TelegramVoiceTranscriberDependencies,
): Promise<Uint8Array> {
  const { filePath } = await dependencies.getFile(fileId, signal);
  const response = await dependencies.downloadFile(filePath, signal);
  if (!response.ok) throw voiceDownloadFailed();
  return readLimitedBody(response, dependencies.maxBytes);
}

async function downloadVoice(
  voice: TelegramVoiceFile,
  dependencies: TelegramVoiceTranscriberDependencies,
): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    const deadline = AbortSignal.timeout(dependencies.downloadAttemptTimeoutMs);
    try {
      return await downloadVoiceOnce(
        voice.fileId,
        voice.signal ? AbortSignal.any([deadline, voice.signal]) : deadline,
        dependencies,
      );
    } catch (error) {
      // The caller's cancellation is its own decision; an AppError here is already a verdict on the
      // file itself (Telegram's error answer, an oversized file), which a repeat would not change.
      if (voice.signal?.aborted || isAppError(error)) throw error;
      const transient = deadline.aborted
        || (error instanceof TypeError && FETCH_CONNECTION_FAILURE_MESSAGES.has(error.message));
      if (!transient || attempt >= dependencies.downloadAttempts) throw voiceDownloadFailed(error);
      console.warn(JSON.stringify({
        code: "AGENT_VOICE_DOWNLOAD_RETRIED",
        attempt,
        cause: error instanceof Error ? error.message : String(error),
        // Node's fetch names the network failure only on its cause: ECONNRESET, UND_ERR_SOCKET.
        causeCode: error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined,
        fileSize: voice.fileSize,
      }));
    }
  }
}

export function createTelegramVoiceTranscriber(dependencies: TelegramVoiceTranscriberDependencies) {
  return async function transcribeVoice(voice: TelegramVoiceFile): Promise<string> {
    voice.signal?.throwIfAborted();
    // Reject untrusted metadata before making Telegram or Groq requests.
    if (voice.fileSize !== undefined && voice.fileSize > dependencies.maxBytes) {
      throw new AppError(
        "AGENT_VOICE_FILE_TOO_LARGE",
        "Голосовое сообщение превышает допустимый размер. Отправьте более короткую запись",
      );
    }
    if (voice.mimeType && !SUPPORTED_VOICE_MEDIA_TYPES.has(voice.mimeType.toLowerCase())) {
      throw new AppError(
        "AGENT_VOICE_MEDIA_TYPE_UNSUPPORTED",
        "Формат голосового сообщения не поддерживается. Отправьте запись в формате Telegram Voice",
      );
    }

    const audio = await downloadVoice(voice, dependencies);
    voice.signal?.throwIfAborted();
    // A voice note must contain Ogg pages with an Opus identification header, a video note an MP4 box.
    const valid = voice.mimeType?.toLowerCase() === VIDEO_NOTE_MEDIA_TYPE
      ? startsWith(audio.subarray(MP4_FTYP_OFFSET), MP4_FTYP_SIGNATURE)
      : startsWith(audio, OGG_SIGNATURE) && includesSignature(audio, OPUS_HEAD_SIGNATURE);
    if (!valid) {
      throw new AppError(
        "AGENT_VOICE_CONTENT_INVALID",
        "Telegram передал повреждённое голосовое сообщение. Запишите и отправьте его заново",
      );
    }
    return dependencies.transcribe(audio, voice.signal);
  };
}

/** The attempt's signal carries its deadline; without it a stalled request would never end. */
function telegramFetchWithSignal(signal: AbortSignal) {
  return (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
  });
}

// The runtime's Telegram API takes the bot token explicitly; a missing token fails the call.
const telegramCredentials = () => ({ botToken: process.env.TELEGRAM_BOT_TOKEN });

export const transcribeTelegramVoice = createTelegramVoiceTranscriber({
  downloadFile: (filePath, signal) => downloadTelegramFile({
    credentials: telegramCredentials(), fetch: telegramFetchWithSignal(signal), filePath,
  }),
  downloadAttemptTimeoutMs: TELEGRAM_VOICE_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
  downloadAttempts: TELEGRAM_VOICE_DOWNLOAD_ATTEMPTS,
  getFile: async (fileId, signal) => {
    const file = await getTelegramFile({ credentials: telegramCredentials(), fetch: telegramFetchWithSignal(signal), fileId });
    return { filePath: file.filePath };
  },
  maxBytes: TELEGRAM_VOICE_MAX_BYTES,
  transcribe: async (audio, signal) => {
    if (voiceTranscriptionModel === null) {
      throw new AppError(
        "AGENT_VOICE_NOT_CONFIGURED",
        "Распознавание голосовых сообщений пока не подключено. Владелец может добавить ключ Groq в настройках",
      );
    }
    const result = await transcribe({
      abortSignal: AbortSignal.any([AbortSignal.timeout(GROQ_TRANSCRIPTION_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      audio,
      maxRetries: 0,
      model: voiceTranscriptionModel,
    });
    return result.text;
  },
});
