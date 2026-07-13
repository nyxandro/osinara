/**
 * Docker sandbox lifecycle policy tests.
 *
 * Constructs covered:
 * - Policy identity ignores transient Eve roots but includes scope and mount changes.
 * - Existing compute is replaced when its owner or policy identity is stale.
 * - Idle detection never stops an operation that is still active.
 * - Idle removal and newly arriving work cannot race on the same container.
 * - Per-sandbox-session creation is serialized.
 */
import { describe, expect, it } from "vitest";

import type { SandboxRunnerCreateRequest } from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import {
  createSandboxActivityRegistry,
  sandboxContainerNeedsReplacement,
  sandboxRequestHash,
} from "./docker-sandbox-lifecycle.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVE_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const NEXT_EVE_SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABD";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const BASE_REQUEST: SandboxRunnerCreateRequest = {
  access: "trusted",
  eveSessionId: EVE_SESSION_ID,
  mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
  sandboxSessionId: SANDBOX_SESSION_ID,
};

describe("Docker sandbox lifecycle", () => {
  it("keeps one policy identity across Eve roots and changes it for another mount", () => {
    expect(sandboxRequestHash({ ...BASE_REQUEST, eveSessionId: NEXT_EVE_SESSION_ID }))
      .toBe(sandboxRequestHash(BASE_REQUEST));
    expect(sandboxRequestHash({
      ...BASE_REQUEST,
      mounts: [{ mountPoint: "personal", workspaceId: OTHER_WORKSPACE_ID }],
    })).not.toBe(sandboxRequestHash(BASE_REQUEST));
  });

  it("replaces compute with stale policy or a different application owner", () => {
    const requestHash = sandboxRequestHash(BASE_REQUEST);

    expect(sandboxContainerNeedsReplacement({
      sandboxSessionId: SANDBOX_SESSION_ID,
      requestHash,
    }, BASE_REQUEST)).toBe(false);
    expect(sandboxContainerNeedsReplacement({
      sandboxSessionId: SANDBOX_SESSION_ID,
      requestHash: "stale-policy",
    }, BASE_REQUEST)).toBe(true);
    expect(sandboxContainerNeedsReplacement({
      sandboxSessionId: OTHER_WORKSPACE_ID,
      requestHash,
    }, BASE_REQUEST)).toBe(true);
  });

  it("marks inactive compute idle without interrupting active operations", async () => {
    let now = 1_000;
    const registry = createSandboxActivityRegistry(() => now);
    registry.touch(SANDBOX_SESSION_ID);
    now = 10_000;

    expect(registry.isIdle(SANDBOX_SESSION_ID, 5_000)).toBe(true);
    let release!: () => void;
    const operation = registry.runActive(
      SANDBOX_SESSION_ID,
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    expect(registry.isIdle(SANDBOX_SESSION_ID, 5_000)).toBe(false);

    release();
    await operation;
    now = 20_000;
    expect(registry.isIdle(SANDBOX_SESSION_ID, 15_000)).toBe(true);
  });

  it("serializes creation for the same application session", async () => {
    const registry = createSandboxActivityRegistry(() => 0);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = registry.runExclusive(SANDBOX_SESSION_ID, async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first-end");
    });
    const second = registry.runExclusive(SANDBOX_SESSION_ID, async () => {
      events.push("second");
    });
    await Promise.resolve();

    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("blocks new work until a reserved idle removal completes", async () => {
    const registry = createSandboxActivityRegistry(() => 10_000);
    const events: string[] = [];
    let releaseRemoval!: () => void;
    const removal = registry.removeIfIdle(SANDBOX_SESSION_ID, 5_000, async () => {
      events.push("remove-start");
      await new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      events.push("remove-end");
    });
    const work = registry.runActive(SANDBOX_SESSION_ID, async () => {
      events.push("work");
    });
    await Promise.resolve();

    expect(events).toEqual(["remove-start"]);
    releaseRemoval();
    await Promise.all([removal, work]);
    expect(events).toEqual(["remove-start", "remove-end", "work"]);
  });
});
