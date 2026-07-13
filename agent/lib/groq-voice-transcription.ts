/**
 * Telegram voice download and Groq transcription adapter.
 *
 * Exports:
 * - `TelegramVoiceFile`: trusted subset of Telegram voice metadata.
 * - `createTelegramVoiceTranscriber`: dependency-injected validation/download pipeline.
 * - `transcribeTelegramVoice`: production Eve Telegram and Groq implementation.
 */
import { transcribe } from "ai";
import { downloadTelegramFile, getTelegramFile } from "eve/channels/telegram";

import {
  GROQ_TRANSCRIPTION_TIMEOUT_MS,
  TELEGRAM_API_REQUEST_TIMEOUT_MS,
  TELEGRAM_VOICE_MAX_BYTES,
} from "../config.js";
import { AppError } from "./app-error.js";
import { voiceTranscriptionModel } from "./model-registry.js";

const OGG_SIGNATURE = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const OPUS_HEAD_SIGNATURE = new TextEncoder().encode("OpusHead");
const SUPPORTED_VOICE_MEDIA_TYPES = new Set([
  "application/ogg",
  "audio/ogg",
  "audio/opus",
  "audio/x-opus+ogg",
]);

export interface TelegramVoiceFile {
  fileId: string;
  fileSize?: number;
  mimeType?: string;
}

interface TelegramVoiceTranscriberDependencies {
  downloadFile(filePath: string): Promise<Response>;
  getFile(fileId: string): Promise<{ filePath: string }>;
  maxBytes: number;
  transcribe(audio: Uint8Array): Promise<string>;
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
  if (!response.body) {
    throw new AppError(
      "AGENT_VOICE_DOWNLOAD_FAILED",
      "Не удалось скачать голосовое сообщение из Telegram. Попробуйте отправить его снова",
    );
  }

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

export function createTelegramVoiceTranscriber(dependencies: TelegramVoiceTranscriberDependencies) {
  return async function transcribeVoice(voice: TelegramVoiceFile): Promise<string> {
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

    const { filePath } = await dependencies.getFile(voice.fileId);
    const response = await dependencies.downloadFile(filePath);
    if (!response.ok) {
      throw new AppError(
        "AGENT_VOICE_DOWNLOAD_FAILED",
        "Не удалось скачать голосовое сообщение из Telegram. Попробуйте отправить его снова",
      );
    }

    // Telegram voice notes must contain Ogg pages with an Opus identification header.
    const audio = await readLimitedBody(response, dependencies.maxBytes);
    if (!startsWith(audio, OGG_SIGNATURE) || !includesSignature(audio, OPUS_HEAD_SIGNATURE)) {
      throw new AppError(
        "AGENT_VOICE_CONTENT_INVALID",
        "Telegram передал повреждённое голосовое сообщение. Запишите и отправьте его заново",
      );
    }
    return dependencies.transcribe(audio);
  };
}

function telegramFetchWithTimeout(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS),
  });
}

export const transcribeTelegramVoice = createTelegramVoiceTranscriber({
  downloadFile: (filePath) => downloadTelegramFile({ fetch: telegramFetchWithTimeout, filePath }),
  getFile: async (fileId) => {
    const file = await getTelegramFile({ fetch: telegramFetchWithTimeout, fileId });
    return { filePath: file.filePath };
  },
  maxBytes: TELEGRAM_VOICE_MAX_BYTES,
  transcribe: async (audio) => {
    const result = await transcribe({
      abortSignal: AbortSignal.timeout(GROQ_TRANSCRIPTION_TIMEOUT_MS),
      audio,
      maxRetries: 0,
      model: voiceTranscriptionModel,
    });
    return result.text;
  },
});
