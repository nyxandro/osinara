/**
 * Workspace file delivery through Telegram multipart Bot API.
 *
 * Export:
 * - `deliverWorkspaceFile`: sends exact bytes as an explicit photo or document.
 */
import { resolveTelegramBotToken } from "eve/channels/telegram";

import {
  TELEGRAM_API_REQUEST_TIMEOUT_MS,
  TELEGRAM_MAX_OUTBOUND_DOCUMENT_BYTES,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { renderTelegramMarkdownHtml } from "../telegram-markdown.js";

const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_CAPTION_MAX_CHARACTERS = 1_024;
const TELEGRAM_PHOTO_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface TelegramSendResponse {
  ok?: boolean;
  result?: { message_id?: number };
}

async function parseTelegramSendResponse(response: Response): Promise<TelegramSendResponse> {
  try {
    return await response.json() as TelegramSendResponse;
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_WORKSPACE_FILE_DELIVERY_RESPONSE_INVALID",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_RESPONSE_INVALID",
      "Telegram не подтвердил отправку файла. Проверьте чат перед повторным запросом",
    );
  }
}

export async function deliverWorkspaceFile(
  input: {
    bytes: Uint8Array;
    caption?: string;
    chatId: string;
    fileName: string;
    mediaType: string;
    messageThreadId?: number;
    presentation: "document" | "photo";
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ telegramMessageId: string }> {
  if (input.bytes.byteLength > TELEGRAM_MAX_OUTBOUND_DOCUMENT_BYTES) {
    throw new AppError("AGENT_WORKSPACE_FILE_TOO_LARGE", "Файл превышает лимит отправки Telegram 50 МБ");
  }
  if (input.presentation === "photo") {
    if (!TELEGRAM_PHOTO_MEDIA_TYPES.has(input.mediaType)) {
      throw new AppError(
        "AGENT_TELEGRAM_PHOTO_TYPE_INVALID",
        "Как фотографию можно отправить JPEG, PNG или WebP; используйте документ для другого формата",
      );
    }
    if (input.bytes.byteLength > TELEGRAM_PHOTO_MAX_BYTES) {
      throw new AppError(
        "AGENT_TELEGRAM_PHOTO_TOO_LARGE",
        "Изображение превышает лимит фотографии 10 МБ. Отправьте его как документ",
      );
    }
  }

  const token = await resolveTelegramBotToken();
  const field = input.presentation === "photo" ? "photo" : "document";
  const method = input.presentation === "photo" ? "sendPhoto" : "sendDocument";
  const form = new FormData();
  form.set("chat_id", input.chatId);
  if (input.messageThreadId !== undefined) {
    form.set("message_thread_id", String(input.messageThreadId));
  }
  if (input.caption !== undefined) {
    const caption = renderTelegramMarkdownHtml(input.caption);
    if (caption.length > TELEGRAM_CAPTION_MAX_CHARACTERS) {
      throw new AppError(
        "AGENT_TELEGRAM_CAPTION_TOO_LONG",
        "Подпись превышает лимит Telegram 1024 символа. Сократите подпись или отправьте текст отдельно",
      );
    }
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }
  form.set(field, new Blob([Buffer.from(input.bytes)], { type: input.mediaType }), input.fileName);

  let response: Response;
  try {
    response = await fetchImplementation(`https://api.telegram.org/bot${token}/${method}`, {
      body: form,
      method: "POST",
      signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
      "Не удалось подтвердить отправку файла. Проверьте чат перед повторным запросом",
    );
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      code: "AGENT_WORKSPACE_FILE_DELIVERY_FAILED",
      providerStatus: response.status,
    }));
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_FAILED",
      "Telegram не принял файл. Попробуйте отправить его как документ или повторите позже",
    );
  }
  const payload = await parseTelegramSendResponse(response);
  const messageId = payload.result?.message_id;
  if (payload.ok !== true || !Number.isSafeInteger(messageId)) {
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_RESPONSE_INVALID",
      "Telegram не подтвердил отправку файла. Проверьте чат перед повторным запросом",
    );
  }
  return { telegramMessageId: String(messageId) };
}
