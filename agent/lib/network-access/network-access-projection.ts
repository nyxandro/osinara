/**
 * Publication of active network access grants to the sandbox egress proxy.
 *
 * Exports:
 * - `NetworkAccessPublisher`: rewrites the grant file the proxy reads.
 * - `createNetworkAccessPublisher`: a publisher over a grant source and a directory.
 * - `networkAccessPublisher`: the agent's publisher over the database and the shared volume.
 */
import { resolve } from "node:path";

import {
  NETWORK_ACCESS_DIRECTORY_NAME,
  NETWORK_ACCESS_PROJECTION_FILE_NAME,
  parseNetworkAccessProjection,
  serializeNetworkAccessProjection,
  type NetworkAccessGrant,
} from "./network-access-contract.js";
import { networkAccessRepository } from "./network-access-repository.js";
import { createProjectionPublisher, type ProjectionPublisher } from "./projection-file.js";

export type NetworkAccessPublisher = ProjectionPublisher;

export function createNetworkAccessPublisher(options: {
  directory: string;
  loadGrants: () => Promise<readonly NetworkAccessGrant[]>;
}): NetworkAccessPublisher {
  return createProjectionPublisher({
    directory: options.directory,
    failure: {
      code: "AGENT_NETWORK_ACCESS_PUBLISH_FAILED",
      message: "Не удалось применить список разрешённых сетевых адресов. Попробуйте ещё раз",
    },
    fileName: NETWORK_ACCESS_PROJECTION_FILE_NAME,
    async render() {
      const projection = serializeNetworkAccessProjection(await options.loadGrants());
      // The proxy rejects the whole file over one bad entry; failing here keeps the last good list.
      parseNetworkAccessProjection(projection);
      return projection;
    },
  });
}

export const networkAccessPublisher = createNetworkAccessPublisher({
  directory: resolve(NETWORK_ACCESS_DIRECTORY_NAME),
  loadGrants: () => networkAccessRepository.listAllActiveDestinations(),
});
