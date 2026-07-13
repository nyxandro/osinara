/**
 * Telegram attachment content policy.
 *
 * Exports:
 * - `ValidatedAttachmentContent`: canonical safe filename and verified media type.
 * - `validateAttachmentContent`: verifies bytes, extension, declared MIME, and UTF-8 text.
 */
import { extname, posix } from "node:path";

import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../app-error.js";

const ATTACHMENT_FILENAME_MAX_CHARACTERS = 180;
const OCTET_STREAM_MEDIA_TYPE = "application/octet-stream";

const BINARY_EXTENSION_MEDIA_TYPES: Readonly<Record<string, readonly string[]>> = {
  ".avif": ["image/avif"],
  ".doc": ["application/x-cfb"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".gif": ["image/gif"],
  ".heic": ["image/heic", "image/heif"],
  ".heif": ["image/heic", "image/heif"],
  ".jpeg": ["image/jpeg"],
  ".jpg": ["image/jpeg"],
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".ppt": ["application/x-cfb"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".tif": ["image/tiff"],
  ".tiff": ["image/tiff"],
  ".webp": ["image/webp"],
  ".xls": ["application/x-cfb"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};

const DECLARED_BINARY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ".doc": ["application/msword", "application/x-cfb"],
  ".xls": ["application/vnd.ms-excel", "application/x-cfb"],
  ".ppt": ["application/vnd.ms-powerpoint", "application/x-cfb"],
};

const TEXT_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export interface ValidatedAttachmentContent {
  fileName: string;
  mediaType: string;
}

function normalizeMediaType(mediaType: string | undefined): string | null {
  if (!mediaType) return null;
  return mediaType.split(";", 1)[0]!.trim().toLowerCase();
}

export function sanitizeAttachmentFileName(fileName: string): string {
  const normalized = posix.basename(fileName.replaceAll("\\", "/")).normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, "_").trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw new AppError("AGENT_ATTACHMENT_FILENAME_INVALID", "Telegram передал некорректное имя файла");
  }
  if (normalized.length <= ATTACHMENT_FILENAME_MAX_CHARACTERS) return normalized;

  // Preserve the extension because both validation and later document tooling depend on it.
  const extension = extname(normalized);
  const stemLength = ATTACHMENT_FILENAME_MAX_CHARACTERS - extension.length;
  return `${normalized.slice(0, stemLength)}${extension}`;
}

function assertDeclaredMediaType(
  declared: string | null,
  extension: string,
  accepted: readonly string[],
): void {
  if (declared === null || declared === OCTET_STREAM_MEDIA_TYPE) return;
  const aliases = DECLARED_BINARY_ALIASES[extension] ?? accepted;
  if (aliases.includes(declared)) return;
  throw new AppError(
    "AGENT_ATTACHMENT_TYPE_MISMATCH",
    "Тип содержимого файла не совпадает с его именем. Отправьте исходный файл без переименования",
  );
}

export async function validateAttachmentContent(input: {
  bytes: Uint8Array;
  declaredMediaType?: string;
  fileName: string;
  kind: "document" | "photo";
}): Promise<ValidatedAttachmentContent> {
  const fileName = sanitizeAttachmentFileName(input.fileName);
  const extension = extname(fileName).toLowerCase();
  const declared = normalizeMediaType(input.declaredMediaType);
  const detected = await fileTypeFromBuffer(input.bytes);

  // Binary uploads must agree with a narrow extension allowlist and magic-byte detection.
  if (detected) {
    const accepted = BINARY_EXTENSION_MEDIA_TYPES[extension];
    if (!accepted?.includes(detected.mime)) {
      throw new AppError(
        accepted ? "AGENT_ATTACHMENT_TYPE_MISMATCH" : "AGENT_ATTACHMENT_TYPE_FORBIDDEN",
        accepted
          ? "Тип содержимого файла не совпадает с его именем. Отправьте исходный файл без переименования"
          : "Этот тип файла нельзя сохранить. Используйте изображение, PDF, Office или текстовый документ",
      );
    }
    if (input.kind === "photo" && !detected.mime.startsWith("image/")) {
      throw new AppError("AGENT_ATTACHMENT_TYPE_MISMATCH", "Полученная фотография не является изображением");
    }
    assertDeclaredMediaType(declared, extension, accepted);
    return { fileName, mediaType: detected.mime };
  }

  // Text has no reliable magic bytes, so require a supported extension and strict UTF-8 decoding.
  const textMediaType = TEXT_EXTENSION_MEDIA_TYPES[extension];
  if (!textMediaType || input.kind === "photo") {
    throw new AppError(
      "AGENT_ATTACHMENT_TYPE_FORBIDDEN",
      "Этот тип файла нельзя сохранить. Используйте изображение, PDF, Office или текстовый документ",
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_ATTACHMENT_TEXT_ENCODING_INVALID",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw new AppError(
      "AGENT_ATTACHMENT_TEXT_ENCODING_INVALID",
      "Текстовый документ должен быть сохранён в кодировке UTF-8",
    );
  }
  if (declared !== null && declared !== OCTET_STREAM_MEDIA_TYPE && declared !== textMediaType) {
    throw new AppError(
      "AGENT_ATTACHMENT_TYPE_MISMATCH",
      "Тип текстового документа не совпадает с его расширением",
    );
  }
  return { fileName, mediaType: textMediaType };
}
