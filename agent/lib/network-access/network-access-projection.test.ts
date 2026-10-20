/**
 * Network access grant publication tests.
 *
 * Constructs covered:
 * - The published file is the projection format the proxy parses, readable by the proxy user.
 * - Publications run one at a time, each reading the grants after the previous write, so a slow
 *   earlier publication never overwrites a newer list.
 * - A failed publication carries its own code and does not block the next one.
 */
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseNetworkAccessProjection, type NetworkAccessGrant } from "./network-access-contract.js";
import { createNetworkAccessPublisher } from "./network-access-projection.js";

let directory: string;

async function published(): Promise<NetworkAccessGrant[]> {
  return parseNetworkAccessProjection(await readFile(join(directory, "grants.json"), "utf8"));
}

describe("network access publisher", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "network-access-publisher-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("writes the active grants for the proxy", async () => {
    const publisher = createNetworkAccessPublisher({
      directory,
      loadGrants: async () => [{ address: "100.91.171.16", port: 8123 }],
    });

    await publisher.publish();

    expect(await published()).toEqual([{ address: "100.91.171.16", port: 8123 }]);
    expect((await stat(join(directory, "grants.json"))).mode & 0o777).toBe(0o644);
    expect(await readdir(directory)).toEqual(["grants.json"]);
  });

  it("never lets an earlier publication overwrite a newer grant list", async () => {
    let current: NetworkAccessGrant[] = [{ address: "100.91.171.16", port: 8123 }];
    let releaseFirstLoad!: () => void;
    const firstLoadGate = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
    let loads = 0;
    const publisher = createNetworkAccessPublisher({
      directory,
      loadGrants: async () => {
        loads += 1;
        const snapshot = current;
        if (loads === 1) await firstLoadGate;
        return snapshot;
      },
    });

    const first = publisher.publish();
    current = [];
    const second = publisher.publish();
    releaseFirstLoad();
    await Promise.all([first, second]);

    expect(await published()).toEqual([]);
  });

  it("refuses to publish a list the proxy would reject and keeps the last good file", async () => {
    let grants: NetworkAccessGrant[] = [{ address: "100.91.171.16", port: 8123 }];
    const publisher = createNetworkAccessPublisher({ directory, loadGrants: async () => grants });
    await publisher.publish();

    grants = [{ address: "127.0.0.1", port: 22 }];

    await expect(publisher.publish()).rejects.toMatchObject({ code: "AGENT_NETWORK_ACCESS_PUBLISH_FAILED" });
    expect(await published()).toEqual([{ address: "100.91.171.16", port: 8123 }]);
  });

  it("reports a failed publication with its code and keeps publishing afterwards", async () => {
    let fail = true;
    const publisher = createNetworkAccessPublisher({
      directory,
      loadGrants: async () => {
        if (fail) throw new Error("database unavailable");
        return [];
      },
    });

    await expect(publisher.publish()).rejects.toMatchObject({ code: "AGENT_NETWORK_ACCESS_PUBLISH_FAILED" });
    fail = false;
    await expect(publisher.publish()).resolves.toBeUndefined();
    expect(await published()).toEqual([]);
  });
});
