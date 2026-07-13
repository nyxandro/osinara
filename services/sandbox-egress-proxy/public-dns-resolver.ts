/**
 * Public-only DNS resolution for sandbox egress.
 *
 * Exports:
 * - `PublicDnsClient`: minimal injectable DNS client contract.
 * - `PublicInternetAddress`: validated and connectable public IP result.
 * - `resolvePublicInternetAddress`: resolves through independent DNS and applies SSRF policy.
 */
import { Resolver } from "node:dns/promises";

import { isPublicInternetAddress } from "./address-policy.js";

const PUBLIC_DNS_SERVER = "1.1.1.1";
const PUBLIC_DNS_TIMEOUT_MS = 5_000;
const PUBLIC_DNS_ATTEMPTS = 1;

export interface PublicDnsClient {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export interface PublicInternetAddress {
  address: string;
  family: 4 | 6;
}

const publicDnsClient = new Resolver({
  timeout: PUBLIC_DNS_TIMEOUT_MS,
  tries: PUBLIC_DNS_ATTEMPTS,
});
publicDnsClient.setServers([PUBLIC_DNS_SERVER]);

function addressesFrom(
  result: PromiseSettledResult<string[]>,
  family: 4 | 6,
): PublicInternetAddress[] {
  // A or AAAA may legitimately be absent, so only fulfilled answers contribute candidates.
  if (result.status === "rejected") return [];
  return result.value.map((address) => ({ address, family }));
}

export async function resolvePublicInternetAddress(
  hostname: string,
  client: PublicDnsClient = publicDnsClient,
): Promise<PublicInternetAddress> {
  // Independent public DNS avoids VPN fake-IP answers while one bounded query per family avoids retries.
  const [ipv4, ipv6] = await Promise.allSettled([
    client.resolve4(hostname),
    client.resolve6(hostname),
  ]);
  const candidates = [
    ...addressesFrom(ipv4, 4),
    ...addressesFrom(ipv6, 6),
  ];

  // The selected address is pinned by the caller for the connection, preventing DNS rebinding.
  const publicAddress = candidates.find((candidate) =>
    isPublicInternetAddress(candidate.address)
  );
  if (!publicAddress) {
    throw new Error(
      "AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN: Destination has no public DNS address",
    );
  }
  return publicAddress;
}
