/**
 * Read-before-write stamps of the built-in file tools.
 *
 * Exports:
 * - `normalizeModelPath`: the key a stamp is stored under.
 * - `createReadFileStamp`: length and SHA-256 of the content the model last saw.
 *
 * The stamps live in the session tool state (`ctx.state`).
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { ReadFileStamp } from "../session/tool-state.js";

export function normalizeModelPath(path: string): string {
  return posix.normalize(path);
}

export function createReadFileStamp(input: { readonly content: string; readonly filePath: string }): ReadFileStamp {
  return {
    byteLength: Buffer.byteLength(input.content, "utf8"),
    contentHash: createHash("sha256").update(input.content, "utf8").digest("hex"),
    filePath: input.filePath,
  };
}
