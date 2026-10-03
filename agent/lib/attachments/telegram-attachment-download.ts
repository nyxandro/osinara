/**
 * Telegram attachment download boundary.
 *
 * Exports:
 * - `createTelegramAttachmentDownloader`: testable getFile/download coordinator with exact limits.
 * - `downloadTelegramAttachment`: production downloader using the runtime's Telegram API.
 */
import { downloadTelegramFile, getTelegramFile } from "../../runtime/telegram/api.js";
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";

import { TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES } from "../../config.js";
import { AppError, isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";

interface TelegramAttachmentDownloadAdapter {
  downloadFile(filePath: string): Promise<Response>;
  getFile(fileId: string): Promise<{ filePath: string }>;
}

function assertDownloadSize(size: number): void {
  if (size > TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES) {
    throw new AppError(
      "AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE",
      "Telegram позволяет боту получить входящий файл размером не более 20 МБ",
    );
  }
}

function throwDownloadFailure(error: unknown): never {
  if (isAppError(error)) throw error;
  console.error(JSON.stringify({
    code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }));
  throw new ModelFacingError({
    category: "dependency",
    code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
    correction: "Не повторяйте скачивание автоматически. Попросите пользователя отправить файл ещё раз.",
    reason: "Не удалось получить файл из Telegram из-за транспортного сбоя.",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

export function createTelegramAttachmentDownloader(adapter: TelegramAttachmentDownloadAdapter) {
  return async (attachment: TelegramAttachment): Promise<Buffer> => {
    if (attachment.size !== undefined) assertDownloadSize(attachment.size);
    let response: Response;
    try {
      const metadata = await adapter.getFile(attachment.fileId);
      response = await adapter.downloadFile(metadata.filePath);
    } catch (error) {
      throwDownloadFailure(error);
    }
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
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throwDownloadFailure(error);
    }
    assertDownloadSize(bytes.byteLength);
    return bytes;
  };
}

export const downloadTelegramAttachment = createTelegramAttachmentDownloader({
  downloadFile: (filePath) => downloadTelegramFile({ filePath }),
  getFile: (fileId) => getTelegramFile({ fileId }),
});
