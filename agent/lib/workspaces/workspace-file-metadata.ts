/**
 * Workspace file metadata detector.
 *
 * Export:
 * - `detectWorkspaceFileMetadata`: derives MIME from bytes and searchable text from strict UTF-8.
 */
import { extname } from "node:path";

import { fileTypeFromBuffer } from "file-type";

import { WORKSPACE_TOOL_MAX_TEXT_BYTES } from "../../config.js";

const TEXT_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".ts": "text/typescript",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

function decodeWorkspaceUtf8(content: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

export async function detectWorkspaceFileMetadata(
  content: Uint8Array,
  path: string,
): Promise<{ extractedText: string | null; mediaType: string }> {
  const detected = await fileTypeFromBuffer(content);
  if (detected) return { extractedText: null, mediaType: detected.mime };

  const mediaType = TEXT_EXTENSION_MEDIA_TYPES[extname(path).toLowerCase()];
  if (!mediaType || content.byteLength > WORKSPACE_TOOL_MAX_TEXT_BYTES) {
    return { extractedText: null, mediaType: "application/octet-stream" };
  }
  const extractedText = decodeWorkspaceUtf8(content);
  // A misleading text extension must not make binary data searchable or model-readable.
  return extractedText === null
    ? { extractedText: null, mediaType: "application/octet-stream" }
    : { extractedText, mediaType };
}
