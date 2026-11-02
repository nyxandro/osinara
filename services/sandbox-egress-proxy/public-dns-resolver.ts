/**
 * Public-only DNS resolution for sandbox egress.
 *
 * Exports:
 * - `PublicDnsClient`: minimal injectable DNS client contract.
 * - `PublicInternetAddress`: validated and connectable public IP result.
 * - `resolvePublicInternetAddress`: resolves through independent DNS and applies SSRF policy.
 * - `EgressHostNotFound`: public DNS answered that the name has no IPv4 address.
 */
import { NODATA, NOTFOUND } from "node:dns";
import { Resolver } from "node:dns/promises";

import { isPublicInternetAddress } from "./address-policy.js";
import { SANDBOX_EGRESS_HOST_NOT_FOUND_CODE } from "./egress-log.js";

const PUBLIC_DNS_SERVER = "1.1.1.1";
const PUBLIC_DNS_TIMEOUT_MS = 5_000;
const PUBLIC_DNS_ATTEMPTS = 1;

export interface PublicDnsClient {
  resolve4(hostname: string): Promise<string[]>;
}

export interface PublicInternetAddress {
  address: string;
  family: 4;
}

export class EgressHostNotFound extends Error {
  readonly code = SANDBOX_EGRESS_HOST_NOT_FOUND_CODE;

  constructor(readonly hostname: string, readonly dnsCode: string, options?: { readonly cause?: unknown }) {
    super(`${SANDBOX_EGRESS_HOST_NOT_FOUND_CODE}: ${hostname} has no IPv4 address in public DNS`, options);
    this.name = "EgressHostNotFound";
  }
}

const publicDnsClient = new Resolver({
  timeout: PUBLIC_DNS_TIMEOUT_MS,
  tries: PUBLIC_DNS_ATTEMPTS,
});
publicDnsClient.setServers([PUBLIC_DNS_SERVER]);

export async function resolvePublicInternetAddress(
  hostname: string,
  client: PublicDnsClient = publicDnsClient,
): Promise<PublicInternetAddress> {
  // This deployment has no IPv6 route, so an AAAA answer is never a connectable fallback.
  let addresses: string[];
  try {
    addresses = await client.resolve4(hostname);
  } catch (error) {
    const dnsCode = (error as NodeJS.ErrnoException | undefined)?.code;
    if (dnsCode === NOTFOUND || dnsCode === NODATA) throw new EgressHostNotFound(hostname, dnsCode, { cause: error });
    throw new Error(
      `AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED: IPv4 DNS resolution failed (${dnsCode ?? "no DNS code"})`,
      { cause: error },
    );
  }

  // The selected address is pinned by the caller for the connection, preventing DNS rebinding.
  const publicAddress = addresses.find(isPublicInternetAddress);
  if (!publicAddress) {
    throw new Error(
      "AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN: Destination has no public IPv4 address",
    );
  }
  return { address: publicAddress, family: 4 };
}
