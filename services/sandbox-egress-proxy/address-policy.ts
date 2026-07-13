/**
 * Public-internet-only address policy for sandbox egress.
 *
 * Export:
 * - `isPublicInternetAddress`: rejects private, local, reserved, and documentation ranges.
 */
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();

// IPv4 ranges include local infrastructure, carrier NAT, benchmarks, multicast, and reserved space.
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}

// IPv6 ranges cover unspecified/loopback, unique-local, link-local, documentation, and multicast.
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["2001:db8::", 32],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return match?.[1] ?? null;
}

export function isPublicInternetAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped) return isIP(mapped) === 4 && !blocked.check(mapped, "ipv4");
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return !blocked.check(address, "ipv6");
  return false;
}
