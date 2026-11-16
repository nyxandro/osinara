/**
 * Telegram attachment download boundary.
 *
 * Exports:
 * - `createTelegramAttachmentDownloader`: testable getFile/download coordinator with exact limits.
 * - `downloadTelegramAttachment`: production downloader using the runtime's Telegram API.
 *
 * Key construct:
 * - The metadata request, the download and the body run under one deadline per attempt, repeated
 *   once after a stall or a dropped connection, as voice notes are (`telegram-file-download-attempts.ts`).
 */
import { downloadTelegramFile, getTelegramFile } from "../../runtime/telegram/api.js";
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";

import {
  TELEGRAM_FILE_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
  TELEGRAM_FILE_DOWNLOAD_ATTEMPTS,
  TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import {
  telegramFetchWithSignal,
  type TelegramFileAttemptPolicy,
  withTelegramFileAttempts,
} from "../telegram-file-download-attempts.js";

interface TelegramAttachmentDownloadAdapter extends TelegramFileAttemptPolicy {
  downloadFile(filePath: string, signal: AbortSignal): Promise<Response>;
  getFile(fileId: string, signal: AbortSignal): Promise<{ filePath: string }>;
}

function assertDownloadSize(size: number): void {
  if (size > TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES) {
    throw new AppError(
      "AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE",
      "Telegram позволяет боту получить входящий файл размером не более 20 МБ",
    );
  }
}

function downloadFailure(error: unknown): ModelFacingError {
  console.error(JSON.stringify({
    code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }));
  return new ModelFacingError({
    category: "dependency",
    code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
    correction: "Не повторяйте скачивание автоматически. Попросите пользователя отправить файл ещё раз.",
    reason: "Не удалось получить файл из Telegram из-за транспортного сбоя.",
    retryable: false,
    sideEffectStatus: "not_started",
  }, { cause: error });
}

async function downloadOnce(
  attachment: TelegramAttachment,
  signal: AbortSignal,
  adapter: TelegramAttachmentDownloadAdapter,
): Promise<Buffer> {
  const metadata = await adapter.getFile(attachment.fileId, signal);
  const response = await adapter.downloadFile(metadata.filePath, signal);
  if (!response.ok) {
    console.error(JSON.stringify({
      code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
      providerStatus: response.status,
    }));
    throw new AppError(
      "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
      "Не удалось получить файл из Telegram. Отправьте его ещё раз",
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AppError(
        "AGENT_ATTACHMENT_DOWNLOAD_RESPONSE_INVALID",
        "Telegram вернул некорректные данные файла. Отправьте его ещё раз",
      );
    }
    assertDownloadSize(length);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assertDownloadSize(bytes.byteLength);
  return bytes;
}

export function createTelegramAttachmentDownloader(adapter: TelegramAttachmentDownloadAdapter) {
  return async (attachment: TelegramAttachment): Promise<Buffer> => {
    if (attachment.size !== undefined) assertDownloadSize(attachment.size);
    return withTelegramFileAttempts({
      attempt: (signal) => downloadOnce(attachment, signal, adapter),
      fail: downloadFailure,
      onRetry: (retry) => console.warn(JSON.stringify({
        code: "AGENT_ATTACHMENT_DOWNLOAD_RETRIED",
        ...retry,
        kind: attachment.kind,
        size: attachment.size,
      })),
      policy: adapter,
    });
  };
}

// The runtime's Telegram API takes the bot token explicitly; a missing token fails the call.
const credentials = () => ({ botToken: process.env.TELEGRAM_BOT_TOKEN });

export const downloadTelegramAttachment = createTelegramAttachmentDownloader({
  attemptTimeoutMs: TELEGRAM_FILE_DOWNLOAD_ATTEMPT_TIMEOUT_MS,
  attempts: TELEGRAM_FILE_DOWNLOAD_ATTEMPTS,
  downloadFile: (filePath, signal) => downloadTelegramFile({
    credentials: credentials(), fetch: telegramFetchWithSignal(signal), filePath,
  }),
  getFile: (fileId, signal) => getTelegramFile({ credentials: credentials(), fetch: telegramFetchWithSignal(signal), fileId }),
});
