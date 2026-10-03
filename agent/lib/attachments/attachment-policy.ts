/**
 * Telegram attachment content policy.
 *
 * Exports:
 * - `ValidatedAttachmentContent`: canonical safe filename and content-derived media type.
 * - `validateAttachmentContent`: accepts arbitrary documents while validating native photos.
 * - External readable-text candidate and content guards for the restricted group workspace.
 */
import { extname, posix } from "node:path";

import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../app-error.js";

const ATTACHMENT_FILENAME_MAX_CHARACTERS = 180;
const OCTET_STREAM_MEDIA_TYPE = "application/octet-stream";

const TEXT_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".tsv": "text/tab-separated-values",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

const EXTERNAL_TEXT_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".tsv": "text/tab-separated-values",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export interface ValidatedAttachmentContent {
  fileName: string;
  mediaType: string;
}

export function isReadableTextDocumentCandidate(input: {
  fileName?: string;
  kind: "document" | "photo";
  mediaType?: string;
}): boolean {
  if (input.kind !== "document" || !input.fileName) return false;
  const extension = extname(input.fileName.normalize("NFKC")).toLowerCase();
  return EXTERNAL_TEXT_EXTENSION_MEDIA_TYPES[extension] !== undefined;
}

function textRequired(): AppError {
  return new AppError(
    "AGENT_ATTACHMENT_TEXT_REQUIRED",
    "В этой группе можно импортировать только UTF-8 файлы TXT, Markdown, JSON, CSV, TSV, HTML, XML или YAML",
  );
}

export async function validateReadableTextAttachmentContent(input: {
  bytes: Uint8Array;
  declaredMediaType?: string;
  fileName: string;
  kind: "document" | "photo";
}): Promise<ValidatedAttachmentContent> {
  const fileName = sanitizeAttachmentFileName(input.fileName);
  if (!isReadableTextDocumentCandidate({
    fileName,
    kind: input.kind,
    ...(input.declaredMediaType ? { mediaType: input.declaredMediaType } : {}),
  })) throw textRequired();
  const expectedMediaType = EXTERNAL_TEXT_EXTENSION_MEDIA_TYPES[extname(fileName).toLowerCase()]!;
  const detected = await fileTypeFromBuffer(input.bytes);
  // `file-type` recognizes XML despite its textual payload. Accept only an exact allowlisted match;
  // every binary format or text format hidden under a different extension remains rejected.
  if (detected && detected.mime !== expectedMediaType) throw textRequired();

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    // `read_file` rejects NUL-bearing files as binary, so persistence must prove the same contract.
    if (text.includes("\0")) throw textRequired();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw textRequired();
  }
  return {
    fileName,
    mediaType: expectedMediaType,
  };
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

export async function validateAttachmentContent(input: {
  bytes: Uint8Array;
  declaredMediaType?: string;
  fileName: string;
  kind: "document" | "photo";
}): Promise<ValidatedAttachmentContent> {
  const fileName = sanitizeAttachmentFileName(input.fileName);
  const extension = extname(fileName).toLowerCase();
  const detected = await fileTypeFromBuffer(input.bytes);

  // Telegram's native photo transport must still contain an actual image. Documents deliberately
  // accept any detected binary format and retain the content-derived MIME despite misleading names.
  if (input.kind === "photo") {
    if (!detected?.mime.startsWith("image/")) {
      throw new AppError(
        "AGENT_ATTACHMENT_TYPE_MISMATCH",
        "Полученная фотография не является изображением",
      );
    }
    return { fileName, mediaType: detected.mime };
  }
  if (detected) return { fileName, mediaType: detected.mime };

  // Known text extensions become model-readable only after strict UTF-8 validation. Every other
  // opaque payload is still persisted, but receives a conservative binary MIME.
  const textMediaType = TEXT_EXTENSION_MEDIA_TYPES[extension];
  if (textMediaType) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
      return { fileName, mediaType: textMediaType };
    } catch {
      // A text-looking filename never upgrades undecodable bytes to trusted text.
    }
  }
  return { fileName, mediaType: OCTET_STREAM_MEDIA_TYPE };
}
