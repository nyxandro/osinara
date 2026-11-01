/**
 * Sandbox egress proxy process entrypoint.
 *
 * Constructs:
 * - Finds the proxy's own address on the trusted sandbox network before accepting connections.
 * - Starts the forward proxy on the fixed internal port with the owner-approved access gate.
 * - Starts the API key gateway on its own port. Without the integration key the gateway refuses
 *   every request with its code, while the forward proxy keeps serving all other traffic.
 */
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  API_KEY_GATEWAY_PORT,
  API_KEY_PROJECTION_FILE_NAME,
  groupEgressProxyAlias,
  parseApiKeyProjection,
} from "../../agent/lib/api-keys/api-key-contract.js";
import {
  apiKeyUsageToken,
  decryptApiKeyValue,
  INTEGRATION_KEY_ENVIRONMENT_NAME,
} from "../../agent/lib/api-keys/api-key-crypto.js";
import {
  NETWORK_ACCESS_DIRECTORY_NAME,
  NETWORK_ACCESS_PROJECTION_FILE_NAME,
} from "../../agent/lib/network-access/network-access-contract.js";
import { createApiKeyGateway } from "./api-key-gateway.js";
import { createAgentUsageSender, createApiKeyUsageReporter } from "./api-key-usage-reporter.js";
import { createNetworkAccessGate, proxyAttachedSubnets } from "./network-access-gate.js";
import { resolvePublicInternetAddress } from "./public-dns-resolver.js";
import { createSandboxEgressProxy } from "./server.js";

const PROXY_PORT = 3128;
const USAGE_FLUSH_MILLISECONDS = 5_000;
// About a day of heavy use; past it the oldest unreported uses are dropped with a log line.
const USAGE_MAX_BUFFERED = 20_000;
// How long an open connection to an IP destination can outlive the revocation of its grant.
const GRANT_RECHECK_MILLISECONDS = 15_000;
// Compose gives the proxy this alias on the trusted sandbox network only, so Docker DNS answers it
// with the proxy's own address on that network and nothing else.
const TRUSTED_NETWORK_ALIAS = "sandbox-trusted-egress-proxy";

async function ownAddress(alias: string, code: string): Promise<string> {
  try {
    return (await lookup(alias, { family: 4 })).address;
  } catch (error) {
    throw new Error(`${code}: Alias ${alias} is not resolvable`, { cause: error });
  }
}

function requiredAgentBaseUrl(): string {
  const value = process.env.AGENT_INTERNAL_BASE_URL;
  if (!value) throw new Error("AGENT_SANDBOX_EGRESS_CONFIG_MISSING: AGENT_INTERNAL_BASE_URL is not configured");
  return value;
}

const agentBaseUrl = requiredAgentBaseUrl();
const trustedLocalAddress = await ownAddress(TRUSTED_NETWORK_ALIAS, "AGENT_SANDBOX_EGRESS_TRUSTED_NETWORK_UNRESOLVED");
const server = createSandboxEgressProxy({
  grantRecheckMilliseconds: GRANT_RECHECK_MILLISECONDS,
  networkAccess: createNetworkAccessGate({
    attachedSubnets: proxyAttachedSubnets,
    projectionPath: resolve(NETWORK_ACCESS_DIRECTORY_NAME, NETWORK_ACCESS_PROJECTION_FILE_NAME),
    trustedLocalAddress,
  }),
});
server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log("Sandbox egress proxy ready", { port: PROXY_PORT });
});

const integrationKey = process.env[INTEGRATION_KEY_ENVIRONMENT_NAME];
if (!integrationKey) {
  console.warn(JSON.stringify({
    code: "AGENT_SANDBOX_API_KEY_GATEWAY_UNCONFIGURED",
    message: `${INTEGRATION_KEY_ENVIRONMENT_NAME} is not set; every API key request is refused`,
  }));
}
// Without the integration key nothing is decrypted, so no use can happen and nothing is reported.
const usage = createApiKeyUsageReporter({
  maxBuffered: USAGE_MAX_BUFFERED,
  now: () => new Date(),
  send: integrationKey
    ? createAgentUsageSender({ agentBaseUrl, token: apiKeyUsageToken(integrationKey) })
    : async () => undefined,
});
usage.start(USAGE_FLUSH_MILLISECONDS);
const apiKeyProjectionPath = resolve(NETWORK_ACCESS_DIRECTORY_NAME, API_KEY_PROJECTION_FILE_NAME);
const gateway = createApiKeyGateway({
  decrypt: (value) => decryptApiKeyValue(value, integrationKey),
  loadGrants: async () => parseApiKeyProjection(await readFile(apiKeyProjectionPath, "utf8")),
  networkAddress: (network) => network.kind === "trusted"
    ? Promise.resolve(trustedLocalAddress)
    : ownAddress(groupEgressProxyAlias(network.workspaceId), "AGENT_SANDBOX_API_KEY_GROUP_NETWORK_UNRESOLVED"),
  recordUsage: (event) => usage.record(event),
  resolveUpstream: (hostname) => resolvePublicInternetAddress(hostname),
});
gateway.listen(API_KEY_GATEWAY_PORT, "0.0.0.0", () => {
  console.log("Sandbox API key gateway ready", { port: API_KEY_GATEWAY_PORT });
});
