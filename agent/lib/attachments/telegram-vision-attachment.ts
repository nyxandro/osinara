/**
 * Telegram static-image attachment policy.
 *
 * Exports:
 * - `validateVisionImageBytes`: derives the authoritative supported MIME from downloaded bytes.
 */
import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../app-error.js";

export const VISION_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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
