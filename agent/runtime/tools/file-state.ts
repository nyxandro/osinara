/**
 * Read-before-write stamps of the built-in file tools.
 *
 * Exports:
 * - `normalizeModelPath`: the key a stamp is stored under.
 * - `createReadFileStamp`: length and SHA-256 of the content the model last saw.
 *
 * Ported from eve 0.40.0 `runtime/framework-tools/file-state.ts` (Apache-2.0, see NOTICE-eve).
 * Changes: the stamps live in the session tool state (`ctx.state`) instead of Eve's context.
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
