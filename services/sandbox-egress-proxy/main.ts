/**
 * Sandbox egress proxy process entrypoint.
 *
 * Constructs:
 * - Finds the proxy's own address on the trusted sandbox network before accepting connections.
 * - Starts the forward proxy on the fixed internal port with the owner-approved access gate.
 */
import { lookup } from "node:dns/promises";
import { resolve } from "node:path";

import {
  NETWORK_ACCESS_DIRECTORY_NAME,
  NETWORK_ACCESS_PROJECTION_FILE_NAME,
} from "../../agent/lib/network-access/network-access-contract.js";
import { createNetworkAccessGate, proxyAttachedSubnets } from "./network-access-gate.js";
import { createSandboxEgressProxy } from "./server.js";

const PROXY_PORT = 3128;
// How long an open connection to an IP destination can outlive the revocation of its grant.
const GRANT_RECHECK_MILLISECONDS = 15_000;
// Compose gives the proxy this alias on the trusted sandbox network only, so Docker DNS answers it
// with the proxy's own address on that network and nothing else.
const TRUSTED_NETWORK_ALIAS = "sandbox-trusted-egress-proxy";

async function trustedNetworkAddress(): Promise<string> {
  try {
    return (await lookup(TRUSTED_NETWORK_ALIAS, { family: 4 })).address;
  } catch (error) {
    throw new Error(
      `AGENT_SANDBOX_EGRESS_TRUSTED_NETWORK_UNRESOLVED: Alias ${TRUSTED_NETWORK_ALIAS} is not resolvable`,
      { cause: error },
    );
  }
}

const server = createSandboxEgressProxy({
  grantRecheckMilliseconds: GRANT_RECHECK_MILLISECONDS,
  networkAccess: createNetworkAccessGate({
    attachedSubnets: proxyAttachedSubnets,
    projectionPath: resolve(NETWORK_ACCESS_DIRECTORY_NAME, NETWORK_ACCESS_PROJECTION_FILE_NAME),
    trustedLocalAddress: await trustedNetworkAddress(),
  }),
});
server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log("Sandbox egress proxy ready", { port: PROXY_PORT });
});
