/**
 * Telegram attachment download boundary.
 *
 * Exports:
 * - `createTelegramAttachmentDownloader`: testable getFile/download coordinator with exact limits.
 * - `downloadTelegramAttachment`: production downloader using Eve's public Telegram API.
 */
import {
  downloadTelegramFile,
  getTelegramFile,
  type TelegramAttachment,
} from "eve/channels/telegram";

import { TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES } from "../../config.js";
import { AppError } from "../app-error.js";

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

export function createTelegramAttachmentDownloader(adapter: TelegramAttachmentDownloadAdapter) {
  return async (attachment: TelegramAttachment): Promise<Buffer> => {
    if (attachment.size !== undefined) assertDownloadSize(attachment.size);
    const metadata = await adapter.getFile(attachment.fileId);
    const response = await adapter.downloadFile(metadata.filePath);
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
  };
}

export const downloadTelegramAttachment = createTelegramAttachmentDownloader({
  downloadFile: (filePath) => downloadTelegramFile({ filePath }),
  getFile: (fileId) => getTelegramFile({ fileId }),
});
