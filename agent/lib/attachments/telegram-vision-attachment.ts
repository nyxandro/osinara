/**
 * Telegram static-image attachment policy.
 *
 * Exports:
 * - `isTelegramImageDocumentCandidate`: validates pre-download document metadata.
 * - `validateVisionImageBytes`: derives the authoritative supported MIME from downloaded bytes.
 */
import { extname } from "node:path";

import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";
import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../app-error.js";

export const VISION_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const VISION_IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);

export function isTelegramImageDocumentCandidate(
  attachment: Pick<TelegramAttachment, "fileName" | "kind" | "mediaType">,
): boolean {
  if (attachment.kind !== "document") return false;
  return attachment.mediaType?.toLowerCase().startsWith("image/") === true ||
    (attachment.fileName !== undefined &&
      VISION_IMAGE_EXTENSIONS.has(extname(attachment.fileName).toLowerCase()));
}

export async function validateVisionImageBytes(bytes: Uint8Array): Promise<string> {
  // Downloaded magic bytes are authoritative; Telegram MIME and filename are only candidates.
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !VISION_IMAGE_MEDIA_TYPES.has(detected.mime)) {
    throw new AppError(
      "AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED",
      "Вложение не является поддерживаемым статическим изображением",
    );
  }
  return detected.mime;
}
