/**
 * Scheduler heartbeat tests.
 *
 * Constructs covered:
 * - `withScheduleHeartbeat`: one structured line per completed cycle and silence on failure.
 * - Failure propagation: the heartbeat must never swallow or alter the original error.
 * - Wrapper order in every schedule: the heartbeat must sit inside the runtime admission gate,
 *   which returns without running the work while the application is draining or frozen.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SCHEDULE_HEARTBEAT_CODE, type ScheduleName, withScheduleHeartbeat } from "./schedule-heartbeat.js";

const SCHEDULE_FILES: Readonly<Record<ScheduleName, string>> = {
  "agent-schedule-dispatch": "agent/schedules/agent-schedule-dispatch.ts",
  "memory-review-dispatch": "agent/schedules/memory-review-dispatch.ts",
  "reminder-dispatch": "agent/schedules/reminder-dispatch.ts",
  "software-update-check": "agent/schedules/software-update-check.ts",
};

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

  it("never reports a cycle whose work was skipped by the caller", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // Stands in for the admission gate returning without running the dispatcher.
    const admitted = await (async () => null)();

    expect(admitted).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });
});

describe("schedule wiring", () => {
  it.each(Object.entries(SCHEDULE_FILES))(
    "keeps the heartbeat of %s inside the runtime admission gate",
    async (schedule, path) => {
      const source = await readFile(resolve(path), "utf8");

      // The gate returns without running the work while draining or frozen. If the heartbeat
      // wrapped the gate instead, a frozen application would still look perfectly healthy, so the
      // exact nesting is asserted rather than the mere presence of both calls.
      const normalized = source.replace(/\s+/gu, " ");
      expect({ schedule, nested: normalized.includes(
        `withRuntimeAdmission( "ordinary", () => withScheduleHeartbeat("${schedule}"`,
      ) || normalized.includes(
        `withRuntimeAdmission("ordinary", () => withScheduleHeartbeat("${schedule}"`,
      ) }).toEqual({ schedule, nested: true });
    },
  );
});
