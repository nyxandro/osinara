/**
 * Root installation bundle validation boundary.
 *
 * Exports:
 * - `validateInstallationBundle`: validates paths, types, modes, size, and exact archive contents.
 * - `readInstallationBundle`: returns validated regular-file bytes keyed by canonical archive path.
 *
 * Key constructs:
 * - Closed regular-file and directory allowlist for every root-executed archive entry.
 * - Uncompressed byte limit protecting extraction from compressed archive expansion.
 */
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import tar from "tar-stream";

import { InstallerError } from "./errors.js";

const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
const ALLOWED_ENTRIES = new Map<string, { mode: number; type: "directory" | "file" }>([
  ["installation/", { mode: 0o755, type: "directory" }],
  ["installation/compose.installation.json", { mode: 0o644, type: "file" }],
  ["installation/osinara-deployment.json", { mode: 0o644, type: "file" }],
  ["installation/traefik-compose.yaml", { mode: 0o644, type: "file" }],
  ["installation/traefik-osinara.yaml", { mode: 0o644, type: "file" }],
]);

function bundleEntryError(message: string, cause?: unknown): InstallerError {
  return new InstallerError("OSINARA_INSTALL_BUNDLE_ENTRY_INVALID", message, { cause });
}

/** Validates all headers and consumes all bytes before root extraction is allowed. */
export async function readInstallationBundle(
  archive: Uint8Array,
): Promise<ReadonlyMap<string, Buffer>> {
  return await new Promise<ReadonlyMap<string, Buffer>>((resolve, reject) => {
    const extract = tar.extract();
    const files = new Map<string, Buffer>();
    const seen = new Set<string>();
    let totalBytes = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof InstallerError
        ? error
        : bundleEntryError("Не удалось разобрать installation bundle", error));
      extract.destroy();
    };

    extract.on("entry", (header, stream, next) => {
      const expected = ALLOWED_ENTRIES.get(header.name);
      const mode = header.mode === undefined ? undefined : header.mode & 0o777;
      if (!expected || seen.has(header.name) || header.type !== expected.type || mode !== expected.mode) {
        stream.resume();
        fail(bundleEntryError(`Недопустимая запись installation bundle: ${header.name}`));
        return;
      }
      seen.add(header.name);
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (expected.type === "file") chunks.push(Buffer.from(chunk));
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
          fail(bundleEntryError(
            `Распакованный installation bundle превышает ${MAX_UNCOMPRESSED_BYTES} байт`,
          ));
        }
      });
      stream.on("error", fail);
      stream.on("end", () => {
        if (expected.type === "file") files.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    extract.on("error", fail);
    extract.on("finish", () => {
      if (settled) return;
      if (seen.size !== ALLOWED_ENTRIES.size) {
        fail(bundleEntryError("Installation bundle не содержит полный обязательный набор файлов"));
        return;
      }
      settled = true;
      resolve(files);
    });

    const gunzip = createGunzip();
    gunzip.on("error", fail);
    Readable.from(archive).pipe(gunzip).pipe(extract);
  });
}

export async function validateInstallationBundle(archive: Uint8Array): Promise<void> {
  await readInstallationBundle(archive);
}
