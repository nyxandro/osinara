/**
 * Public DNS resolution tests for sandbox egress.
 *
 * Constructs covered:
 * - Public answers are selected even when the host DNS also returns VPN fake-IP addresses.
 * - Private, reserved, and fake-IP-only answers remain blocked by the SSRF policy.
 */
import { describe, expect, it, vi } from "vitest";

import {
  resolvePublicInternetAddress,
  type PublicDnsClient,
} from "./public-dns-resolver.js";

function dnsClient(ipv4: string[], ipv6: string[] = []): PublicDnsClient {
  return {
    resolve4: vi.fn(async () => ipv4),
    resolve6: vi.fn(async () => ipv6),
  };
}

describe("resolvePublicInternetAddress", () => {
  it("ignores a VPN fake-IP answer and pins a real public address", async () => {
    const result = await resolvePublicInternetAddress(
      "github.com",
      dnsClient(["198.18.0.4", "140.82.121.4"]),
    );

    expect(result).toEqual({ address: "140.82.121.4", family: 4 });
  });

  it("rejects a destination when DNS returns only non-public addresses", async () => {
    await expect(
      resolvePublicInternetAddress("internal.example", dnsClient(["198.18.0.4", "10.0.0.1"])),
    ).rejects.toThrow("AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN");
  });
});
