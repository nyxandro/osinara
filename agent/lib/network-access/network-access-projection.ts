/**
 * Publication of active network access grants to the sandbox egress proxy.
 *
 * Exports:
 * - `NetworkAccessPublisher`: rewrites the grant file the proxy reads.
 * - `createNetworkAccessPublisher`: a publisher over a grant source and a directory.
 * - `networkAccessPublisher`: the agent's publisher over the database and the shared volume.
 *
 * The database is the source of truth. The file is rebuilt from it after every change and on
 * startup, so a write lost to a crash is repaired by the next start.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AppError } from "../app-error.js";
import {
  NETWORK_ACCESS_DIRECTORY_NAME,
  NETWORK_ACCESS_PROJECTION_FILE_NAME,
  parseNetworkAccessProjection,
  serializeNetworkAccessProjection,
  type NetworkAccessGrant,
} from "./network-access-contract.js";
import { networkAccessRepository } from "./network-access-repository.js";

// The proxy runs as an unprivileged user and only needs to read the file.
const PROJECTION_FILE_MODE = 0o644;

export interface NetworkAccessPublisher {
  publish(): Promise<void>;
}

export function createNetworkAccessPublisher(options: {
  directory: string;
  loadGrants: () => Promise<readonly NetworkAccessGrant[]>;
}): NetworkAccessPublisher {
  const write = async (): Promise<void> => {
    try {
      const projection = serializeNetworkAccessProjection(await options.loadGrants());
      // The proxy rejects the whole file over one bad entry; failing here keeps the last good list.
      parseNetworkAccessProjection(projection);
      await mkdir(options.directory, { recursive: true });
      const temporary = join(options.directory, `.grants-${randomUUID()}.tmp`);
      try {
        // A same-volume rename means the proxy never reads a partially written list.
        await writeFile(temporary, projection, { flag: "wx" });
        await chmod(temporary, PROJECTION_FILE_MODE);
        await rename(temporary, join(options.directory, NETWORK_ACCESS_PROJECTION_FILE_NAME));
      } finally {
        await rm(temporary, { force: true });
      }
    } catch (error) {
      throw new AppError(
        "AGENT_NETWORK_ACCESS_PUBLISH_FAILED",
        "Не удалось применить список разрешённых сетевых адресов. Попробуйте ещё раз",
        { cause: error },
      );
    }
  };

  let queue: Promise<void> = Promise.resolve();
  return {
    publish() {
      // Each publication reads the grants only after the previous one wrote its file.
      const next = queue.then(write);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

export const networkAccessPublisher = createNetworkAccessPublisher({
  directory: resolve(NETWORK_ACCESS_DIRECTORY_NAME),
  loadGrants: () => networkAccessRepository.listAllActiveDestinations(),
});
