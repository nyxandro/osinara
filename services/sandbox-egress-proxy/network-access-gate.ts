/**
 * Owner-approved access from family sandboxes to IP destinations.
 *
 * Exports:
 * - `NetworkAccessRefusal`: why an IP destination was refused, with a code the sandbox may see.
 * - `NetworkAccessGate`: authorizes one connection to an IP address and port.
 * - `createNetworkAccessGate`: the gate over the grant file the agent publishes.
 * - `proxyAttachedSubnets`: the networks this proxy container is attached to, in CIDR notation.
 *
 * Security invariants:
 * - Only a request that arrived on the trusted sandbox network qualifies; external-group sandboxes
 *   and the agent's own page fetches reach the proxy through other networks.
 * - The grant file is read for every connection, so a revocation applies to the next one, and a
 *   missing or damaged file closes every IP destination instead of falling back to a stale list.
 * - Closed ranges and the proxy's own networks are refused even if the file lists them.
 */
import { readFile } from "node:fs/promises";
import { BlockList } from "node:net";
import { networkInterfaces } from "node:os";

import {
  networkAccessDestinationDenial,
  parseNetworkAccessProjection,
} from "../../agent/lib/network-access/network-access-contract.js";

export class NetworkAccessRefusal extends Error {
  readonly clientMessage: string;

  readonly code: string;

  constructor(code: string, clientMessage: string, detail?: string, options?: { cause?: unknown }) {
    super(`${code}: ${clientMessage}${detail ? ` (${detail})` : ""}`, options);
    this.name = "NetworkAccessRefusal";
    this.code = code;
    this.clientMessage = clientMessage;
  }
}

export interface NetworkAccessGate {
  authorize(request: { address: string; localAddress: string | undefined; port: number }): Promise<void>;
}

export interface NetworkAccessGateOptions {
  /** CIDR blocks of every network the proxy is attached to; re-read per request as groups attach. */
  attachedSubnets: () => readonly string[];
  projectionPath: string;
  /** The proxy's own address on the trusted sandbox network. */
  trustedLocalAddress: string;
}

function withoutIpv4MappedPrefix(address: string | undefined): string | undefined {
  return address?.toLowerCase().startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function insideAttachedNetwork(address: string, subnets: readonly string[]): boolean {
  const list = new BlockList();
  for (const subnet of subnets) {
    const [network, prefix] = subnet.split("/");
    list.addSubnet(network!, Number(prefix), "ipv4");
  }
  return list.check(address, "ipv4");
}

async function readGrantedDestinations(projectionPath: string): Promise<ReadonlySet<string>> {
  try {
    const grants = parseNetworkAccessProjection(await readFile(projectionPath, "utf8"));
    return new Set(grants.map(({ address, port }) => `${address}:${port}`));
  } catch (error) {
    throw new NetworkAccessRefusal(
      "AGENT_SANDBOX_EGRESS_GRANTS_UNAVAILABLE",
      "The list of approved network destinations is unavailable",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

export function createNetworkAccessGate(options: NetworkAccessGateOptions): NetworkAccessGate {
  return {
    async authorize({ address, localAddress, port }) {
      if (withoutIpv4MappedPrefix(localAddress) !== options.trustedLocalAddress) {
        throw new NetworkAccessRefusal(
          "AGENT_SANDBOX_EGRESS_GRANT_SCOPE_FORBIDDEN",
          "IP destinations are not available to this sandbox",
        );
      }
      const denial = networkAccessDestinationDenial(address, port);
      if (denial) {
        throw new NetworkAccessRefusal(
          "AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN",
          "This destination can never be opened",
          denial,
        );
      }
      if (insideAttachedNetwork(address, options.attachedSubnets())) {
        throw new NetworkAccessRefusal(
          "AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN",
          "This destination belongs to the agent's own server networks",
        );
      }
      const granted = await readGrantedDestinations(options.projectionPath);
      if (!granted.has(`${address}:${port}`)) {
        throw new NetworkAccessRefusal(
          "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED",
          `${address}:${port} requires network access approved by the owner`,
        );
      }
    },
  };
}

export function proxyAttachedSubnets(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && entry.cidr !== null)
    .map((entry) => entry.cidr!);
}
