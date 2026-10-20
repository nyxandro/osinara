/**
 * Owner-approved network access gate tests.
 *
 * Constructs covered:
 * - Only a request that arrived on the trusted family sandbox network may reach an IP address.
 * - Permanently closed ranges and the proxy's own networks stay closed even when a grant lists them.
 * - A missing or damaged grant file closes every IP destination with its own code.
 * - The grant file is read per request, so a revocation applies to the next connection.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serializeNetworkAccessProjection } from "../../agent/lib/network-access/network-access-contract.js";
import { createNetworkAccessGate, type NetworkAccessGate } from "./network-access-gate.js";

const TRUSTED = "172.20.0.3";

let directory: string;
let projectionPath: string;
let gate: NetworkAccessGate;

async function grant(...destinations: Array<[string, number]>): Promise<void> {
  await writeFile(projectionPath, serializeNetworkAccessProjection(
    destinations.map(([address, port]) => ({ address, port })),
  ));
}

describe("network access gate", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "network-access-gate-"));
    projectionPath = join(directory, "grants.json");
    gate = createNetworkAccessGate({
      attachedSubnets: () => ["172.20.0.3/16", "10.77.0.2/24"],
      projectionPath,
      trustedLocalAddress: TRUSTED,
    });
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("lets a trusted sandbox reach a granted address and port", async () => {
    await grant(["100.91.171.16", 8123]);

    await expect(gate.authorize({ address: "100.91.171.16", localAddress: TRUSTED, port: 8123 }))
      .resolves.toBeUndefined();
    await expect(gate.authorize({ address: "100.91.171.16", localAddress: `::ffff:${TRUSTED}`, port: 8123 }))
      .resolves.toBeUndefined();
  });

  it("asks for approval when the port or address is not granted", async () => {
    await grant(["100.91.171.16", 8123]);

    await expect(gate.authorize({ address: "100.91.171.16", localAddress: TRUSTED, port: 22 }))
      .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED" });
    await expect(gate.authorize({ address: "1.1.1.1", localAddress: TRUSTED, port: 443 }))
      .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED" });
  });

  it("never opens an IP address to a request from another network", async () => {
    await grant(["100.91.171.16", 8123]);

    for (const localAddress of ["172.30.0.2", undefined]) {
      await expect(gate.authorize({ address: "100.91.171.16", localAddress, port: 8123 }))
        .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_GRANT_SCOPE_FORBIDDEN" });
    }
  });

  it("keeps closed ranges and the proxy's own networks closed", async () => {
    await grant(["10.77.0.9", 5432]);

    await expect(gate.authorize({ address: "10.77.0.9", localAddress: TRUSTED, port: 5432 }))
      .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN" });
    for (const address of ["127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.001.1"]) {
      await expect(gate.authorize({ address, localAddress: TRUSTED, port: 80 }))
        .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_DESTINATION_FORBIDDEN" });
    }
  });

  it("closes every IP destination when the grant file is missing or damaged", async () => {
    await expect(gate.authorize({ address: "100.91.171.16", localAddress: TRUSTED, port: 8123 }))
      .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_GRANTS_UNAVAILABLE" });

    await writeFile(projectionPath, "{\"version\":1,\"grants\":[{\"address\":\"100.91.171.16\",\"port\":8123,\"all\":true}]}");
    await expect(gate.authorize({ address: "100.91.171.16", localAddress: TRUSTED, port: 8123 }))
      .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_GRANTS_UNAVAILABLE" });
  });

  it("applies a revocation to the next request", async () => {
    await grant(["100.91.171.16", 8123]);
    await gate.authorize({ address: "100.91.171.16", localAddress: TRUSTED, port: 8123 });

    await grant();

    await expect(gate.authorize({ address: "100.91.171.16", localAddress: TRUSTED, port: 8123 }))
      .rejects.toMatchObject({ code: "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED" });
  });
});
