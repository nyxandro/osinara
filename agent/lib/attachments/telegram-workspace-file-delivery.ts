/**
 * Workspace file delivery through Telegram multipart Bot API.
 *
 * Export:
 * - `WorkspaceFilePresentation`: how Telegram renders the delivered bytes.
 * - `telegramCaptionFits`: whether a caption stays within Telegram's limit after rendering.
 * - `deliverWorkspaceFile`: sends exact bytes as an explicit photo, document, or voice note.
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
// Telegram also plays MP3 and M4A as voice notes, but the only producer here writes Ogg Opus.
const TELEGRAM_VOICE_MEDIA_TYPE = "audio/ogg; codecs=opus";
const TELEGRAM_VOICE_FORBIDDEN_DESCRIPTION = "VOICE_MESSAGES_FORBIDDEN";

const TELEGRAM_METHODS = {
  document: { field: "document", method: "sendDocument" },
  photo: { field: "photo", method: "sendPhoto" },
  voice: { field: "voice", method: "sendVoice" },
} as const;

export type WorkspaceFilePresentation = keyof typeof TELEGRAM_METHODS;

/** Telegram counts caption characters after entity parsing, so the rendered HTML is measured. */
export function telegramCaptionFits(caption: string): boolean {
  return renderTelegramMarkdownHtml(caption).length <= TELEGRAM_CAPTION_MAX_CHARACTERS;
}

interface TelegramSendResponse {
  description?: unknown;
  ok?: boolean;
  result?: { message_id?: number };
}

async function rejectionDescription(response: Response): Promise<string | null> {
  try {
    const payload = await response.json() as TelegramSendResponse;
    return typeof payload.description === "string" ? payload.description : null;
  } catch {
    // The refusal is already definitive by status; an unreadable body only loses its reason.
    return null;
  }
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
      "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
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
    presentation: WorkspaceFilePresentation;
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
  if (input.presentation === "voice" && input.mediaType !== TELEGRAM_VOICE_MEDIA_TYPE) {
    throw new AppError(
      "AGENT_TELEGRAM_VOICE_TYPE_INVALID",
      "Голосовым можно отправить только аудио Ogg Opus",
    );
  }

  const token = await resolveTelegramBotToken();
  const { field, method } = TELEGRAM_METHODS[input.presentation];
  const form = new FormData();
  form.set("chat_id", input.chatId);
  if (input.messageThreadId !== undefined) {
    form.set("message_thread_id", String(input.messageThreadId));
  }
  if (input.caption !== undefined) {
    if (!telegramCaptionFits(input.caption)) {
      throw new AppError(
        "AGENT_TELEGRAM_CAPTION_TOO_LONG",
        "Подпись превышает лимит Telegram 1024 символа. Сократите подпись или отправьте текст отдельно",
      );
    }
    form.set("caption", renderTelegramMarkdownHtml(input.caption));
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
    const description = input.presentation === "voice" ? await rejectionDescription(response) : null;
    const voiceForbidden = description?.includes(TELEGRAM_VOICE_FORBIDDEN_DESCRIPTION) === true;
    console.error(JSON.stringify({
      code: voiceForbidden ? "AGENT_TELEGRAM_VOICE_FORBIDDEN" : "AGENT_WORKSPACE_FILE_DELIVERY_FAILED",
      method,
      providerStatus: response.status,
    }));
    if (voiceForbidden) {
      throw new AppError(
        "AGENT_TELEGRAM_VOICE_FORBIDDEN",
        "Получатель запретил голосовые сообщения в настройках приватности Telegram",
      );
    }
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_FAILED",
      "Telegram не принял файл. Попробуйте отправить его как документ или повторите позже",
    );
  }
  const payload = await parseTelegramSendResponse(response);
  const messageId = payload.result?.message_id;
  if (payload.ok !== true || !Number.isSafeInteger(messageId)) {
    console.error(JSON.stringify({
      code: "AGENT_WORKSPACE_FILE_DELIVERY_RESPONSE_INVALID",
      providerAcknowledged: payload.ok === true,
    }));
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
      "Telegram не подтвердил отправку файла. Проверьте чат перед повторным запросом",
    );
  }
  return { telegramMessageId: String(messageId) };
}
