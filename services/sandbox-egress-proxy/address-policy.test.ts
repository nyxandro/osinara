/**
 * Sandbox egress address policy tests.
 *
 * Constructs covered:
 * - Public IPv4/IPv6 acceptance.
 * - Private, loopback, link-local, documentation, and mapped-address rejection.
 */
import { describe, expect, it } from "vitest";

import { isPublicInternetAddress } from "./address-policy.js";

describe("isPublicInternetAddress", () => {
  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => expect(isPublicInternetAddress(address)).toBe(true),
  );

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.10",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicInternetAddress(address)).toBe(false);
  });
});
