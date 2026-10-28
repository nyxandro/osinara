/**
 * The workspace file behind each answer reference, read with the chat's own rights.
 *
 * Exports:
 * - `AnswerFileKind`, `MeasuredAnswerFile`, `ResolvedAnswerFile`, `AnswerFileProblem`,
 *   `AnswerFileMeasure`, `AnswerFileResolution`: contracts.
 * - `createAnswerFileResolver`: measures a file with the scope's rights without reading it, and
 *   loads its exact bytes with how Telegram shows them; a workspace refusal becomes a problem the
 *   model can fix.
 * - `admitAnswerFiles`: the files one answer may carry, in the order written.
 * - `answerFileResolver`: production resolver over the workspace and `sharp`.
 *
 * Key constructs:
 * - Files are measured first and only those the answer can carry are read, so an answer naming a
 *   whole folder never pulls it into the agent's memory.
 * - Telegram's photo limits are checked here, because it refuses a whole rich message over one
 *   photo it cannot take (PHOTO_INVALID_DIMENSIONS); such a picture still arrives as a document.
 * - Video and audio are only the types tried in a live rich message (MP4, MP3); a GIF there was
 *   refused as an animation and accepted as a document. Anything else is a document.
 * - The files of one answer share one upload limit: every message of the answer then fits it too.
 */
import { basename } from "node:path";

import {
  TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES,
  TELEGRAM_RICH_MESSAGE_MEDIA_MAX_COUNT,
} from "../../config.js";
import { isAppError } from "../app-error.js";
import { loadSharp } from "../native-image-library.js";
import type { WorkspaceBinaryFile } from "../workspaces/workspace-binary-repository.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceScope } from "../workspaces/workspace-file-record.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import type { AnswerFileReference } from "./answer-file-references.js";

export type AnswerFileKind = "audio" | "document" | "photo" | "video";
export type AnswerFileProblem = "forbidden" | "invalid_path" | "not_found" | "too_large";

export interface MeasuredAnswerFile {
  readonly byteSize: number;
  readonly fileName: string;
  readonly path: string;
  readonly scope: WorkspaceScope;
}

export interface ResolvedAnswerFile extends MeasuredAnswerFile {
  readonly bytes: Buffer;
  readonly kind: AnswerFileKind;
  readonly mediaType: string;
  readonly sha256: string;
}

export type AnswerFileMeasure =
  | { readonly file: MeasuredAnswerFile; readonly ok: true }
  | { readonly ok: false; readonly problem: AnswerFileProblem };

export type AnswerFileResolution =
  | { readonly file: ResolvedAnswerFile; readonly ok: true }
  | { readonly ok: false; readonly problem: AnswerFileProblem };

interface ImageSize {
  readonly height: number;
  readonly width: number;
}

const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const TELEGRAM_PHOTO_MAX_SIDE_SUM = 10_000;
const TELEGRAM_PHOTO_MAX_SIDE_RATIO = 20;
const TELEGRAM_PHOTO_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TELEGRAM_RICH_KINDS_BY_MEDIA_TYPE: Readonly<Record<string, AnswerFileKind>> = {
  "audio/mpeg": "audio",
  "video/mp4": "video",
};
const PROBLEMS_BY_WORKSPACE_CODE: Readonly<Record<string, AnswerFileProblem>> = {
  AGENT_WORKSPACE_ACCESS_DENIED: "forbidden",
  AGENT_WORKSPACE_ACCESS_REVOKED: "forbidden",
  AGENT_WORKSPACE_CONTEXT_INVALID: "forbidden",
  AGENT_WORKSPACE_FILE_NOT_FOUND: "not_found",
  AGENT_WORKSPACE_FILE_TOO_LARGE: "too_large",
  AGENT_WORKSPACE_PATH_INVALID: "invalid_path",
};

function photoFits(byteSize: number, size: ImageSize | null): boolean {
  if (byteSize > TELEGRAM_PHOTO_MAX_BYTES || size === null) return false;
  const longer = Math.max(size.width, size.height);
  const shorter = Math.min(size.width, size.height);
  return size.width + size.height <= TELEGRAM_PHOTO_MAX_SIDE_SUM && shorter > 0 &&
    longer / shorter <= TELEGRAM_PHOTO_MAX_SIDE_RATIO;
}

/** A workspace refusal as a problem the model can fix; anything else is not the model's to fix. */
function workspaceProblem(error: unknown): AnswerFileProblem {
  const problem = isAppError(error) ? PROBLEMS_BY_WORKSPACE_CODE[error.code] : undefined;
  if (problem === undefined) throw error;
  return problem;
}

export function createAnswerFileResolver(dependencies: {
  imageSize(bytes: Buffer): Promise<ImageSize | null>;
  readBinary(auth: WorkspaceAuthorization, scope: WorkspaceScope, path: string): Promise<WorkspaceBinaryFile>;
  statBinary(auth: WorkspaceAuthorization, scope: WorkspaceScope, path: string): Promise<{ byteSize: number; path: string }>;
}) {
  async function kindOf(binary: WorkspaceBinaryFile): Promise<AnswerFileKind> {
    const { mediaType } = binary.file;
    if (TELEGRAM_PHOTO_MEDIA_TYPES.has(mediaType)) {
      const size = binary.bytes.byteLength > TELEGRAM_PHOTO_MAX_BYTES ? null : await dependencies.imageSize(binary.bytes);
      return photoFits(binary.bytes.byteLength, size) ? "photo" : "document";
    }
    return TELEGRAM_RICH_KINDS_BY_MEDIA_TYPE[mediaType] ?? "document";
  }

  // `auth` is null where the chat has no workspace at all: every file is out of its reach.
  return {
    async measure(auth: WorkspaceAuthorization | null, reference: AnswerFileReference): Promise<AnswerFileMeasure> {
      if (auth === null) return { ok: false, problem: "forbidden" };
      let stored: { byteSize: number; path: string };
      try {
        stored = await dependencies.statBinary(auth, reference.scope, reference.path);
      } catch (error) {
        return { ok: false, problem: workspaceProblem(error) };
      }
      if (stored.byteSize > TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES) return { ok: false, problem: "too_large" };
      return {
        file: { byteSize: stored.byteSize, fileName: basename(stored.path), path: stored.path, scope: reference.scope },
        ok: true,
      };
    },

    async load(auth: WorkspaceAuthorization | null, reference: AnswerFileReference): Promise<AnswerFileResolution> {
      if (auth === null) return { ok: false, problem: "forbidden" };
      let binary: WorkspaceBinaryFile;
      try {
        binary = await dependencies.readBinary(auth, reference.scope, reference.path);
      } catch (error) {
        return { ok: false, problem: workspaceProblem(error) };
      }
      // The file may have grown since it was measured.
      if (binary.bytes.byteLength > TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES) return { ok: false, problem: "too_large" };
      return {
        file: {
          byteSize: binary.bytes.byteLength,
          bytes: binary.bytes,
          fileName: basename(binary.file.path),
          kind: await kindOf(binary),
          mediaType: binary.file.mediaType,
          path: binary.file.path,
          scope: reference.scope,
          sha256: binary.file.contentSha256,
        },
        ok: true,
      };
    },
  };
}

/**
 * Each file in the order written, or null where the answer is already full. A file used again
 * travels once, so only its first use counts.
 */
export function admitAnswerFiles<File extends MeasuredAnswerFile>(files: readonly File[]): Array<File | null> {
  const admitted = new Set<string>();
  let totalBytes = 0;
  return files.map((file) => {
    const key = `${file.scope}/${file.path}`;
    if (admitted.has(key)) return file;
    if (admitted.size >= TELEGRAM_RICH_MESSAGE_MEDIA_MAX_COUNT || totalBytes + file.byteSize > TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES) {
      return null;
    }
    admitted.add(key);
    totalBytes += file.byteSize;
    return file;
  });
}

async function sharpImageSize(bytes: Buffer): Promise<ImageSize | null> {
  const sharp = await loadSharp();
  try {
    const { height, width } = await sharp(bytes).metadata();
    return typeof width === "number" && typeof height === "number" ? { height, width } : null;
  } catch {
    // A picture sharp cannot read is not a photo Telegram would take; it goes as a document.
    return null;
  }
}

export const answerFileResolver = createAnswerFileResolver({
  imageSize: sharpImageSize,
  readBinary: (auth, scope, path) => workspaceBinaryRepository.readBinary(auth, scope, path),
  statBinary: (auth, scope, path) => workspaceBinaryRepository.statBinary(auth, scope, path),
});
