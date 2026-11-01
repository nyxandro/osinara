/**
 * Publication of sandbox API key grants to the egress proxy.
 *
 * Exports:
 * - `createApiKeyPublisher`: a publisher over a grant source and a directory.
 * - `apiKeyPublisher`: the agent's publisher over the database and the shared volume.
 *
 * The file sits next to the network access grants and carries each value as stored: encrypted.
 * Only the proxy, which holds the API key encryption key, can read a value from it.
 */
import { resolve } from "node:path";

import { NETWORK_ACCESS_DIRECTORY_NAME } from "../network-access/network-access-contract.js";
import { createProjectionPublisher, type ProjectionPublisher } from "../network-access/projection-file.js";
import {
  API_KEY_PROJECTION_FILE_NAME,
  parseApiKeyProjection,
  serializeApiKeyProjection,
  type ApiKeyProjectionGrant,
} from "./api-key-contract.js";
import { apiKeyRepository } from "./api-key-repository.js";

export function createApiKeyPublisher(options: {
  directory: string;
  loadGrants: () => Promise<readonly ApiKeyProjectionGrant[]>;
}): ProjectionPublisher {
  return createProjectionPublisher({
    directory: options.directory,
    failure: {
      code: "AGENT_API_KEY_PUBLISH_FAILED",
      message: "Не удалось применить список выданных ключей API. Попробуйте ещё раз",
    },
    fileName: API_KEY_PROJECTION_FILE_NAME,
    async render() {
      const projection = serializeApiKeyProjection(await options.loadGrants());
      // The proxy refuses the whole file over one bad entry; failing here keeps the last good file.
      parseApiKeyProjection(projection);
      return projection;
    },
  });
}

export const apiKeyPublisher = createApiKeyPublisher({
  directory: resolve(NETWORK_ACCESS_DIRECTORY_NAME),
  loadGrants: () => apiKeyRepository.listProjectionGrants(),
});
