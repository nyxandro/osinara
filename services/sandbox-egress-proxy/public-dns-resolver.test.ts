/**
 * Public DNS resolution tests for sandbox egress.
 *
 * Constructs covered:
 * - Public answers are selected even when the host DNS also returns VPN fake-IP addresses.
 * - Private, reserved, and fake-IP-only answers remain blocked by the SSRF policy.
 * - IPv4 DNS failure never falls through to an unusable public AAAA answer.
 * - A name public DNS knows no IPv4 address for is told apart from a resolver that did not answer,
 *   and a failed resolution carries the resolver's own code.
 */
import { describe, expect, it, vi } from "vitest";

import {
  EgressHostNotFound,
  resolvePublicInternetAddress,
  type PublicDnsClient,
} from "./public-dns-resolver.js";

function dnsClient(ipv4: string[]): PublicDnsClient {
  return {
    resolve4: vi.fn(async () => ipv4),
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

  it("fails on an A-query error without falling through to a public AAAA answer", async () => {
    const dnsError = Object.assign(new Error("A query timed out"), { code: "ETIMEOUT" });
    const client = {
      resolve4: vi.fn(async () => Promise.reject(dnsError)),
      resolve6: vi.fn(async () => ["2607:f8b0:4005:80a::2004"]),
    };

    const resolution = resolvePublicInternetAddress("www.googleapis.com", client);

    await expect(resolution).rejects.toMatchObject({
      cause: dnsError,
      message: expect.stringContaining("AGENT_SANDBOX_EGRESS_IPV4_RESOLUTION_FAILED"),
    });
    await expect(resolution).rejects.toThrow("(ETIMEOUT)");
    expect(client.resolve6).not.toHaveBeenCalled();
  });

  it.each(["ENOTFOUND", "ENODATA"])("reports a name public DNS answers %s for as not found", async (code) => {
    const dnsError = Object.assign(new Error(`queryA ${code} fivpost.ru`), { code });
    const client = { resolve4: vi.fn(async () => Promise.reject(dnsError)) };

    const resolution = resolvePublicInternetAddress("fivpost.ru", client);

    await expect(resolution).rejects.toBeInstanceOf(EgressHostNotFound);
    await expect(resolution).rejects.toMatchObject({
      cause: dnsError,
      code: "AGENT_SANDBOX_EGRESS_HOST_NOT_FOUND",
      dnsCode: code,
      hostname: "fivpost.ru",
    });
  });
});
