/**
 * Files the agent publishes for the sandbox egress proxy in the shared `network-access` volume.
 *
 * Export:
 * - `createProjectionPublisher`: rewrites one file atomically, one publication at a time.
 *
 * The database is the source of truth. A file is rebuilt from it after every change and on
 * startup, so a write lost to a crash is repaired by the next start.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "../app-error.js";

// The proxy runs as an unprivileged user and only needs to read the file.
const PROJECTION_FILE_MODE = 0o644;

export interface ProjectionPublisher {
  publish(): Promise<void>;
}

export function createProjectionPublisher(options: {
  readonly directory: string;
  readonly failure: { readonly code: string; readonly message: string };
  readonly fileName: string;
  /** The file's content; it must throw rather than return a file the proxy would refuse. */
  readonly render: () => Promise<string>;
}): ProjectionPublisher {
  const write = async (): Promise<void> => {
    try {
      const content = await options.render();
      await mkdir(options.directory, { recursive: true });
      const temporary = join(options.directory, `.${options.fileName}-${randomUUID()}.tmp`);
      try {
        // A same-volume rename means the proxy never reads a partially written file.
        await writeFile(temporary, content, { flag: "wx" });
        await chmod(temporary, PROJECTION_FILE_MODE);
        await rename(temporary, join(options.directory, options.fileName));
      } finally {
        await rm(temporary, { force: true });
      }
    } catch (error) {
      throw new AppError(options.failure.code, options.failure.message, { cause: error });
    }
  };

  let queue: Promise<void> = Promise.resolve();
  return {
    publish() {
      // Each publication reads the database only after the previous one wrote its file.
      const next = queue.then(write);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
