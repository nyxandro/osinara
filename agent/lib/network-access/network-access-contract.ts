/**
 * Contract between the agent and the sandbox egress proxy for owner-approved network access.
 *
 * Exports:
 * - `NetworkAccessGrant`: one approved IPv4 address and TCP port.
 * - `NetworkAccessDenial`: why a destination can never be granted.
 * - `NETWORK_ACCESS_DIRECTORY_NAME`, `NETWORK_ACCESS_PROJECTION_FILE_NAME`: the shared volume and
 *   the file in it through which the agent publishes active grants to the proxy.
 * - `networkAccessDestinationDenial`: the refusal reason for an address and port, or null.
 * - `serializeNetworkAccessProjection`, `parseNetworkAccessProjection`: the projection file format.
 * - `SERVER_ADDRESSES_ENVIRONMENT_NAME`, `parseServerAddresses`, `serverAddressesFromEnvironment`: this
 *   server's own public and VPN addresses, which the agent never grants and the proxy never opens (#560).
 *
 * The proxy reads this file on every request, so a damaged file must fail as a whole: parsing never
 * drops an entry it does not understand and never accepts a refused destination.
 */
import { BlockList } from "node:net";

export interface NetworkAccessGrant {
  readonly address: string;
  readonly port: number;
}

export type NetworkAccessDenial =
  | "address_invalid"
  | "container_network"
  | "link_local"
  | "loopback"
  | "multicast"
  | "port_invalid"
  | "reserved"
  | "unspecified";

export const NETWORK_ACCESS_DIRECTORY_NAME = "network-access";
export const NETWORK_ACCESS_PROJECTION_FILE_NAME = "grants.json";

const PROJECTION_VERSION = 1;
const PROJECTION_ERROR = "AGENT_NETWORK_ACCESS_PROJECTION_INVALID";
const MAX_PORT = 65_535;
const CANONICAL_OCTET = /^(0|[1-9][0-9]{0,2})$/u;

// Loopback, Docker's default bridge range 172.16.0.0/12 and the hosting metadata service stay
// closed even when the owner confirms: an approval card can be talked into, these ranges cannot.
// The proxy also closes the networks it is attached to. The server's own public and Tailscale
// addresses come from the deployment (`OSINARA_SERVER_ADDRESSES`) and are refused apart from these
// ranges: a grant file listing one must not close every other grant (#560).
const REFUSED_RANGES: ReadonlyArray<readonly [Exclude<NetworkAccessDenial, "address_invalid" | "port_invalid">, string, number]> = [
  ["unspecified", "0.0.0.0", 8],
  ["loopback", "127.0.0.0", 8],
  ["link_local", "169.254.0.0", 16],
  ["container_network", "172.16.0.0", 12],
  ["multicast", "224.0.0.0", 4],
  ["reserved", "240.0.0.0", 4],
];

const refusedRanges = REFUSED_RANGES.map(([reason, network, prefix]) => {
  const list = new BlockList();
  list.addSubnet(network, prefix, "ipv4");
  return { list, reason };
});

function isCanonicalIpv4(address: string): boolean {
  const parts = address.split(".");
  return parts.length === 4
    && parts.every((part) => CANONICAL_OCTET.test(part) && Number(part) <= 255);
}

export function networkAccessDestinationDenial(address: string, port: number): NetworkAccessDenial | null {
  if (!isCanonicalIpv4(address)) return "address_invalid";
  if (!Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) return "port_invalid";
  return refusedRanges.find(({ list }) => list.check(address, "ipv4"))?.reason ?? null;
}

export function serializeNetworkAccessProjection(grants: readonly NetworkAccessGrant[]): string {
  const document = {
    version: PROJECTION_VERSION,
    grants: grants.map(({ address, port }) => ({ address, port })),
  };
  return `${JSON.stringify(document)}\n`;
}

function projectionError(message: string, cause?: unknown): Error {
  return new Error(`${PROJECTION_ERROR}: ${message}`, cause === undefined ? undefined : { cause });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function parseGrant(value: unknown, index: number): NetworkAccessGrant {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["address", "port"])) {
    throw projectionError(`grant ${index} must contain exactly address and port`);
  }
  const { address, port } = value;
  if (typeof address !== "string" || typeof port !== "number") {
    throw projectionError(`grant ${index} has an address or port of the wrong type`);
  }
  const denial = networkAccessDestinationDenial(address, port);
  if (denial) throw projectionError(`grant ${index} is refused: ${denial}`);
  return { address, port };
}

export function parseNetworkAccessProjection(text: string): NetworkAccessGrant[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw projectionError("file is not JSON", error);
  }
  if (!isPlainRecord(document) || !hasExactKeys(document, ["grants", "version"])) {
    throw projectionError("document must contain exactly version and grants");
  }
  if (document.version !== PROJECTION_VERSION) throw projectionError("unsupported version");
  if (!Array.isArray(document.grants)) throw projectionError("grants must be an array");

  const grants = document.grants.map(parseGrant);
  const destinations = new Set(grants.map(({ address, port }) => `${address}:${port}`));
  if (destinations.size !== grants.length) throw projectionError("grants contain a duplicate destination");
  return grants;
}

export const SERVER_ADDRESSES_ENVIRONMENT_NAME = "OSINARA_SERVER_ADDRESSES";

/**
 * This server's own IPv4 addresses, comma-separated: the public one and any VPN one (Tailscale). They carry
 * services of the host itself — Orca's remote control, the Xray entries — that a sandbox must never reach.
 */
export function parseServerAddresses(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`AGENT_SERVER_ADDRESSES_MISSING: ${SERVER_ADDRESSES_ENVIRONMENT_NAME} must list this server's IPv4 addresses, comma-separated`);
  }
  const addresses = raw.split(",").map((part) => part.trim());
  const invalid = addresses.find((address) => !isCanonicalIpv4(address));
  if (invalid !== undefined) {
    throw new Error(`AGENT_SERVER_ADDRESSES_INVALID: ${SERVER_ADDRESSES_ENVIRONMENT_NAME} holds ${JSON.stringify(invalid)}, not an IPv4 address`);
  }
  return new Set(addresses);
}

export function serverAddressesFromEnvironment(): ReadonlySet<string> {
  return parseServerAddresses(process.env[SERVER_ADDRESSES_ENVIRONMENT_NAME]);
}
