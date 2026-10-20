/**
 * Open connections to owner-approved IP destinations.
 *
 * Constructs covered:
 * - A recheck closes every tracked connection whose destination the gate now refuses, and logs it.
 * - A connection that is still allowed, or no longer tracked, is left alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGrantedConnectionRegistry } from "./granted-connection-registry.js";
import { NetworkAccessRefusal } from "./network-access-gate.js";

const HOUR = 3_600_000;

function connection(address: string) {
  return { address, close: vi.fn(), localAddress: "172.20.0.3", port: 8123 };
}

describe("granted connection registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes a tracked connection once its destination is refused", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    const authorize = vi.fn(async ({ address }: { address: string }) => {
      if (address === "100.91.171.16") {
        throw new NetworkAccessRefusal("AGENT_SANDBOX_EGRESS_GRANT_REQUIRED", "100.91.171.16:8123 requires approval");
      }
    });
    const registry = createGrantedConnectionRegistry({ authorize }, HOUR);
    const revoked = connection("100.91.171.16");
    const allowed = connection("192.168.1.132");
    const finished = connection("10.0.0.7");
    registry.track(revoked);
    registry.track(allowed);
    registry.track(finished)();

    await registry.recheck();
    await registry.recheck();
    registry.stop();

    expect(revoked.close).toHaveBeenCalledOnce();
    expect(allowed.close).not.toHaveBeenCalled();
    expect(finished.close).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalledWith(expect.objectContaining({ address: "10.0.0.7" }));
    expect(errors.map((line) => JSON.parse(line))).toEqual([{
      code: "AGENT_SANDBOX_EGRESS_GRANTED_CONNECTION_CLOSED",
      errorMessage: "AGENT_SANDBOX_EGRESS_GRANT_REQUIRED: 100.91.171.16:8123 requires approval",
      hostname: "100.91.171.16",
      port: 8123,
    }]);
  });

  it("rechecks on its own interval", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = createGrantedConnectionRegistry({
      authorize: async () => {
        throw new NetworkAccessRefusal("AGENT_SANDBOX_EGRESS_GRANTS_UNAVAILABLE", "The list is unavailable");
      },
    }, 15_000);
    const tracked = connection("100.91.171.16");
    registry.track(tracked);

    await vi.advanceTimersByTimeAsync(15_000);
    registry.stop();
    vi.useRealTimers();

    expect(tracked.close).toHaveBeenCalledOnce();
  });
});
