/**
 * Monitor check cycle tests.
 *
 * Constructs covered:
 * - `createScheduleCheckDispatcher`: claims only monitor ticks and runs their checks at most three
 *   at a time; one failing tick never holds back the others.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createScheduleCheckDispatcher } from "./agent-schedule-check-dispatcher.js";
import type { ClaimedAgentSchedule } from "./agent-schedule-dispatch-repository.js";

const tick = (index: number) => ({ id: `monitor-${index}`, leaseToken: `lease-${index}`, monitor: true, runId: `run-${index}` }) as ClaimedAgentSchedule;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("monitor check cycle", () => {
  it("runs at most three checks at once and every claimed tick", async () => {
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const checkMonitor = vi.fn(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
    });
    const claimDueMonitors = vi.fn().mockResolvedValue(Array.from({ length: 5 }, (_, index) => tick(index)));

    const cycle = createScheduleCheckDispatcher({ checkMonitor, claimDueMonitors })(new Date("2026-10-27T10:00:00Z"));
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }

    await expect(cycle).resolves.toBe(5);
    expect(peak).toBe(3);
    expect(checkMonitor).toHaveBeenCalledTimes(5);
    expect(claimDueMonitors).toHaveBeenCalledWith(expect.objectContaining({ now: new Date("2026-10-27T10:00:00Z") }));
  });

  it("keeps checking the other ticks when one fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const checkMonitor = vi.fn().mockRejectedValueOnce(new Error("database gone")).mockResolvedValue("waiting");

    await createScheduleCheckDispatcher({
      checkMonitor,
      claimDueMonitors: vi.fn().mockResolvedValue([tick(1), tick(2)]),
    })(new Date());

    expect(checkMonitor).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("AGENT_SCHEDULE_CHECK_DISPATCH_FAILED"));
  });
});
