/**
 * Bounded Docker archive and stream helpers for sandbox file operations.
 *
 * Exports:
 * - `collectLimitedStream`: reads a Docker stream without exceeding a caller-owned limit.
 * - `readSingleFileArchive`: extracts exactly one bounded regular file.
 * - `writeSingleFileArchive`: writes one bounded file through Docker's archive API.
 */
import { posix } from "node:path";

import type Docker from "dockerode";
import tar from "tar-stream";

import { WORKSPACE_MAX_FILE_BYTES } from "../../agent/config.js";

/** A Node stream with `destroy`, which @types/dockerode leaves out of the streams Docker hands over. */
export type DestroyableStream = NodeJS.ReadableStream & { destroy(error?: Error): unknown };

export async function collectLimitedStream(
  stream: DestroyableStream,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) {
      stream.destroy(new Error("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE: Process output exceeds limit"));
      throw new Error("AGENT_SANDBOX_RUNNER_OUTPUT_TOO_LARGE: Process output exceeds limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export async function readSingleFileArchive(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    const extract = tar.extract();
    let content: Buffer | null = null;
    let entries = 0;
    extract.on("entry", (header, entry, next) => {
      entries += 1;
      if (entries > 1 || header.type !== "file") {
        entry.resume();
        reject(new Error("AGENT_SANDBOX_RUNNER_ARCHIVE_INVALID: Expected one regular file"));
        return;
      }
      void collectLimitedStream(entry, WORKSPACE_MAX_FILE_BYTES).then((bytes) => {
        content = bytes;
        next();
      }, reject);
    });
    extract.on("finish", () => {
      if (content === null) reject(new Error("AGENT_SANDBOX_RUNNER_ARCHIVE_INVALID: File is absent"));
      else resolve(content);
    });
    extract.on("error", reject);
    stream.on("error", reject);
    stream.pipe(extract);
  });
}

export async function writeSingleFileArchive(
  container: Docker.Container,
  path: string,
  content: Uint8Array,
): Promise<void> {
  if (content.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    throw new Error("AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE: File exceeds the 50 MB limit");
  }
  const pack = tar.pack();
  pack.entry({ mode: 0o600, name: posix.basename(path), type: "file" }, Buffer.from(content));
  pack.finalize();
  await container.putArchive(pack, { path: posix.dirname(path) });
}
