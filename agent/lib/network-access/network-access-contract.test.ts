/**
 * Owner-approved network access contract tests.
 *
 * Constructs covered:
 * - Only a canonical IPv4 address and a TCP port can be granted; the server's own and service
 *   ranges are refused even with the owner's confirmation.
 * - The projection file the proxy reads round-trips every valid grant list and rejects anything
 *   else with its own error code, so a damaged file never widens access.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  networkAccessDestinationDenial,
  parseNetworkAccessProjection,
  serializeNetworkAccessProjection,
  type NetworkAccessGrant,
} from "./network-access-contract.js";

// Independent oracle: the refused ranges as inclusive numeric bounds, not the BlockList under test.
const REFUSED_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ["unspecified", 0x00000000, 0x00ffffff],
  ["loopback", 0x7f000000, 0x7fffffff],
  ["link_local", 0xa9fe0000, 0xa9feffff],
  ["container_network", 0xac100000, 0xac1fffff],
  ["multicast", 0xe0000000, 0xefffffff],
  ["reserved", 0xf0000000, 0xffffffff],
];

function addressOf(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function refusedRange(value: number): string | null {
  return REFUSED_RANGES.find(([, start, end]) => value >= start && value <= end)?.[0] ?? null;
}

const grantableAddress = fc.integer({ max: 0xffffffff, min: 0 })
  .filter((value) => refusedRange(value) === null)
  .map(addressOf);
const grant = fc.record({ address: grantableAddress, port: fc.integer({ max: 65_535, min: 1 }) });
const grantList = fc.uniqueArray(grant, {
  maxLength: 20,
  selector: (candidate) => `${candidate.address}:${candidate.port}`,
});

describe("network access destination policy", () => {
  it.each([
    ["100.91.171.16", 8123],
    ["192.168.1.132", 8123],
    ["10.0.0.5", 22],
    ["93.184.216.34", 443],
  ])("accepts %s:%i", (address, port) => {
    expect(networkAccessDestinationDenial(address, port)).toBeNull();
  });

  it.each([
    ["127.0.0.1", 8123, "loopback"],
    ["0.0.0.0", 80, "unspecified"],
    ["169.254.169.254", 80, "link_local"],
    ["172.18.0.1", 5432, "container_network"],
    ["172.31.255.255", 80, "container_network"],
    ["224.0.0.1", 80, "multicast"],
    ["255.255.255.255", 80, "reserved"],
    ["homeassistant.local", 8123, "address_invalid"],
    ["192.168.001.1", 80, "address_invalid"],
    ["::1", 80, "address_invalid"],
    ["100.91.171.16 ", 8123, "address_invalid"],
    ["100.91.171.16", 0, "port_invalid"],
    ["100.91.171.16", 65_536, "port_invalid"],
    ["100.91.171.16", 80.5, "port_invalid"],
  ])("refuses %s:%s as %s", (address, port, reason) => {
    expect(networkAccessDestinationDenial(address, port)).toBe(reason);
  });

  it("classifies every channel string like the numeric oracle", () => {
    const octet = fc.integer({ max: 255, min: 0 });
    const dotted = fc.tuple(octet, octet, octet, octet).map((parts) => parts.join("."));
    // Uniform addresses almost never land inside a narrow refused range, so edges are drawn directly.
    const nearRangeEdge = fc.constantFrom(...REFUSED_RANGES.flatMap(([, start, end]) => [start, end]))
      .chain((edge) => fc.integer({ max: 3, min: -3 }).map((offset) => edge + offset))
      .filter((value) => value >= 0 && value <= 0xffffffff)
      .map(addressOf);
    // What the model can send: canonical addresses, near misses and arbitrary text.
    const channel = fc.oneof(
      dotted,
      nearRangeEdge,
      fc.string({ maxLength: 20 }),
      dotted.map((value) => `0${value}`),
    );
    fc.assert(fc.property(channel, (address) => {
      const parts = address.split(".");
      const canonical = parts.length === 4
        && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
      const value = canonical ? parts.reduce((total, part) => total * 256 + Number(part), 0) : null;
      const expected = value === null ? "address_invalid" : refusedRange(value);
      expect(networkAccessDestinationDenial(address, 8123)).toBe(expected);
    }), {
      examples: [["172.15.255.255"], ["172.32.0.0"], ["169.253.255.255"], ["223.255.255.255"], [""]],
    });
  });
});

describe("network access projection file", () => {
  it("writes one versioned JSON document", () => {
    expect(serializeNetworkAccessProjection([{ address: "100.91.171.16", port: 8123 }]))
      .toBe("{\"version\":1,\"grants\":[{\"address\":\"100.91.171.16\",\"port\":8123}]}\n");
  });

  it("returns every serialized grant list unchanged", () => {
    fc.assert(fc.property(grantList, (grants: NetworkAccessGrant[]) => {
      expect(parseNetworkAccessProjection(serializeNetworkAccessProjection(grants))).toEqual(grants);
    }), { examples: [[[]], [[{ address: "100.91.171.16", port: 8123 }]]] });
  });

  it.each([
    ["not JSON", "{"],
    ["a wrong version", "{\"version\":2,\"grants\":[]}"],
    ["missing grants", "{\"version\":1}"],
    ["an extra field", "{\"version\":1,\"grants\":[],\"all\":true}"],
    ["a grant with an extra field", "{\"version\":1,\"grants\":[{\"address\":\"10.0.0.1\",\"port\":80,\"any\":1}]}"],
    ["a refused address", "{\"version\":1,\"grants\":[{\"address\":\"127.0.0.1\",\"port\":80}]}"],
    ["a port as text", "{\"version\":1,\"grants\":[{\"address\":\"10.0.0.1\",\"port\":\"80\"}]}"],
    ["a duplicate grant", "{\"version\":1,\"grants\":[{\"address\":\"10.0.0.1\",\"port\":80},{\"address\":\"10.0.0.1\",\"port\":80}]}"],
  ])("rejects %s", (_label, text) => {
    expect(() => parseNetworkAccessProjection(text)).toThrow(/^AGENT_NETWORK_ACCESS_PROJECTION_INVALID: /u);
  });
});
