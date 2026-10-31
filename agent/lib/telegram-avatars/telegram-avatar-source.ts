/**
 * The current Telegram profile photo of a chat participant.
 *
 * Exports:
 * - `TelegramAvatarPhoto`, `TelegramAvatarLookup`, `TelegramAvatarSource`: what a lookup finds.
 * - `createTelegramAvatarSource`: testable `getUserProfilePhotos` + download coordinator.
 * - `telegramAvatarSource`: production source through the runtime's Telegram API.
 *
 * Key constructs:
 * - Only the current photo is asked for, every time: an avatar changes, and the agent looks at it
 *   when appearance comes up instead of trusting what it saw before.
 * - "No photo" and "photo hidden from non-contacts" look the same to a bot: an empty list. Telegram
 *   also answers «user not found» for some people who do write in the group; to the bot such a
 *   person has no visible photo either.
 * - Adapted from the fork «Мия» (ilkruglov/osinara, `telegram-avatar-source.ts`, 16.10.2026).
 */
import { callTelegramApi, type TelegramApiResponse } from "../../runtime/telegram/api.js";
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";
import { downloadTelegramAttachment } from "../attachments/telegram-attachment-download.js";
import { ModelFacingError } from "../model-facing-error.js";

/** Telegram offers 160, 320 and 640 px; 640 shows a face clearly and stays small for vision. */
const AVATAR_MAX_SIDE = 640;
const TELEGRAM_USER_ID_PATTERN = /^\d+$/u;

const photoSizeSchema = z.object({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
  file_unique_id: z.string().min(1),
  height: z.number().int().positive(),
  width: z.number().int().positive(),
});
const profilePhotosSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    photos: z.array(z.array(photoSizeSchema)),
    total_count: z.number().int().nonnegative(),
  }),
});

export interface TelegramAvatarPhoto {
  fileId: string;
  fileUniqueId: string;
  height: number;
  size?: number;
  width: number;
}

export type TelegramAvatarLookup = { status: "none" } | { photo: TelegramAvatarPhoto; status: "photo" };

export interface TelegramAvatarSource {
  download(photo: TelegramAvatarPhoto): Promise<Buffer>;
  lookup(telegramUserId: string): Promise<TelegramAvatarLookup>;
}

interface TelegramAvatarSourceAdapter {
  download(attachment: TelegramAttachment): Promise<Buffer>;
  /** The raw answer to `getUserProfilePhotos` for one photo; throws only when the call itself failed. */
  profilePhotos(telegramUserId: string): Promise<TelegramApiResponse>;
}

function largestFitting(sizes: readonly TelegramAvatarPhoto[]): TelegramAvatarPhoto {
  const fitting = sizes.filter((size) => Math.max(size.width, size.height) <= AVATAR_MAX_SIDE);
  // Nothing fits: the smallest still shows the face, the largest would be a download for nothing.
  if (fitting.length === 0) return sizes.reduce((best, size) => (size.width * size.height < best.width * best.height ? size : best));
  return fitting.reduce((best, size) => (size.width * size.height > best.width * best.height ? size : best));
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isUserNotFound(response: TelegramApiResponse): boolean {
  const description = typeof response.body === "object" && response.body !== null && "description" in response.body
    ? (response.body as { description?: unknown }).description
    : undefined;
  return response.status === 400 && typeof description === "string" && /user not found/iu.test(description);
}

/** The stable code of a failure for the log, never its text: it may carry a URL with the token. */
function failureCode(error: unknown): string {
  if (isAppError(error)) return error.code;
  if (error instanceof Error) return /^AGENT_[A-Z_]+/u.exec(error.message)?.[0] ?? error.name;
  return "unknown";
}

function avatarUnavailable(code: "AGENT_TELEGRAM_AVATAR_DOWNLOAD_FAILED" | "AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED", details: Record<string, unknown>): ModelFacingError {
  console.error(JSON.stringify({ code, ...details }));
  return new ModelFacingError({
    category: "dependency",
    code,
    correction: "Не повторяйте запрос автоматически. Скажите, что аватарку сейчас получить не удалось.",
    reason: code === "AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED"
      ? "Telegram не ответил на запрос фото профиля."
      : "Не удалось скачать фото профиля из Telegram.",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

export function createTelegramAvatarSource(adapter: TelegramAvatarSourceAdapter): TelegramAvatarSource {
  return {
    async download(photo) {
      let bytes: Buffer;
      try {
        bytes = await adapter.download({
          fileId: photo.fileId,
          fileUniqueId: photo.fileUniqueId,
          height: photo.height,
          kind: "photo",
          mediaType: "image/jpeg",
          ...(photo.size === undefined ? {} : { size: photo.size }),
          width: photo.width,
        });
      } catch (error) {
        // The shared downloader tells the model to ask for the file again, which is wrong for an avatar.
        throw avatarUnavailable("AGENT_TELEGRAM_AVATAR_DOWNLOAD_FAILED", { error: failureCode(error) });
      }
      // Telegram serves profile photos as JPEG; anything else in the body is not the photo.
      if (!isJpeg(bytes)) {
        throw new AppError("AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID", "Telegram отдал вместо фото профиля что-то другое");
      }
      return bytes;
    },
    async lookup(telegramUserId) {
      if (!TELEGRAM_USER_ID_PATTERN.test(telegramUserId)) {
        throw new AppError("AGENT_TELEGRAM_AVATAR_USER_INVALID", "У автора сообщения нет корректного Telegram ID");
      }
      let response: TelegramApiResponse;
      try {
        response = await adapter.profilePhotos(telegramUserId);
      } catch (error) {
        throw avatarUnavailable("AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED", { error: failureCode(error) });
      }
      if (isUserNotFound(response)) return { status: "none" };
      if (!response.ok) throw avatarUnavailable("AGENT_TELEGRAM_AVATAR_LOOKUP_FAILED", { providerStatus: response.status });
      const parsed = profilePhotosSchema.safeParse(response.body);
      if (!parsed.success) {
        throw new AppError("AGENT_TELEGRAM_AVATAR_RESPONSE_INVALID", "Telegram вернул неожиданный ответ о фото профиля");
      }
      const current = parsed.data.result.photos[0];
      if (current === undefined || current.length === 0) return { status: "none" };
      const photo = largestFitting(current.map((size) => ({
        fileId: size.file_id,
        fileUniqueId: size.file_unique_id,
        height: size.height,
        ...(size.file_size === undefined ? {} : { size: size.file_size }),
        width: size.width,
      })));
      return { photo, status: "photo" };
    },
  };
}

export const telegramAvatarSource = createTelegramAvatarSource({
  download: downloadTelegramAttachment,
  async profilePhotos(telegramUserId) {
    return await callTelegramApi({
      body: { limit: 1, user_id: Number(telegramUserId) },
      // The runtime's Telegram API takes the bot token explicitly; a missing token fails the call.
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      method: "getUserProfilePhotos",
    });
  },
});
