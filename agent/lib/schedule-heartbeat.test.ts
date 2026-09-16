/**
 * Scheduler heartbeat tests.
 *
 * Constructs covered:
 * - `withScheduleHeartbeat`: one structured line per completed cycle and silence on failure.
 * - Failure propagation: the heartbeat must never swallow or alter the original error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { SCHEDULE_HEARTBEAT_CODE, withScheduleHeartbeat } from "./schedule-heartbeat.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withScheduleHeartbeat", () => {
  it("emits exactly one machine-readable line after a completed cycle", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(withScheduleHeartbeat("reminder-dispatch", async () => "done")).resolves.toBe("done");

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({
      code: SCHEDULE_HEARTBEAT_CODE,
      schedule: "reminder-dispatch",
    });
  });

  it("stays silent when the cycle fails, because absence of the line is the alert", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const failure = new Error("dispatch failed");

    await expect(withScheduleHeartbeat("memory-review-dispatch", async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(info).not.toHaveBeenCalled();
  });

  it("rejects a schedule name that would break the log contract", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const run = vi.fn(async () => undefined);

    await expect(withScheduleHeartbeat("", run)).rejects.toMatchObject({
      code: "AGENT_SCHEDULE_HEARTBEAT_INVALID",
    });
    // A misconfigured heartbeat must fail before the work runs, not after a silent half-cycle.
    expect(run).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
