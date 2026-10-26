/**
 * Monitor settings validation tests.
 *
 * Constructs covered:
 * - A monitor needs both its check and its window, exists only as a wake-up in the conversation,
 *   repeats at most every five minutes, and watches for at most fourteen days.
 * - An update can turn a wake-up into a monitor, replace its check (which restarts the failure
 *   count), or move its window; a closed window refuses to resume.
 */
import { describe, expect, it } from "vitest";

import { AppError } from "../app-error.js";
import {
  requireMonitorWindowOpen,
  resolveCreatedScheduleCheck,
  resolveUpdatedScheduleCheck,
} from "./agent-schedule-check-policy.js";

const NOW = new Date("2026-10-27T10:00:00.000Z");
const FIRST = new Date("2026-10-27T10:10:00.000Z");
const CHECK = "curl -s https://clinic.example/slots | grep ноябрь";

function code(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("TEST_EXPECTED_APP_ERROR");
}

const created = {
  checkCommand: CHECK,
  checkUntil: new Date("2026-10-30T10:00:00.000Z"),
  executionContext: "conversation" as const,
  firstRunAt: FIRST,
  recurrence: { interval: 10, kind: "minutely" as const },
};

describe("monitor settings on create", () => {
  it("accepts a check with its window and leaves a plain schedule without one", () => {
    expect(resolveCreatedScheduleCheck(created, NOW)).toEqual({ checkCommand: CHECK, checkUntil: created.checkUntil });
    expect(resolveCreatedScheduleCheck({ ...created, checkCommand: undefined, checkUntil: undefined }, NOW)).toBeNull();
  });

  it("refuses half a monitor, an isolated one, and a blank or oversized script", () => {
    expect(code(() => resolveCreatedScheduleCheck({ ...created, checkUntil: undefined }, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveCreatedScheduleCheck({ ...created, checkCommand: undefined }, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveCreatedScheduleCheck({ ...created, executionContext: "isolated" }, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveCreatedScheduleCheck({ ...created, checkCommand: "  \n" }, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveCreatedScheduleCheck({ ...created, checkCommand: "x".repeat(4_001) }, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
  });

  it("checks at most every five minutes and never once", () => {
    expect(resolveCreatedScheduleCheck({ ...created, recurrence: { interval: 5, kind: "minutely" } }, NOW)).not.toBeNull();
    expect(resolveCreatedScheduleCheck({ ...created, recurrence: { interval: 1, kind: "hourly" } }, NOW)).not.toBeNull();
    expect(code(() => resolveCreatedScheduleCheck({ ...created, recurrence: { interval: 4, kind: "minutely" } }, NOW)))
      .toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveCreatedScheduleCheck({ ...created, recurrence: { kind: "once" } }, NOW)))
      .toBe("AGENT_SCHEDULE_CHECK_INVALID");
  });

  it("watches after the first check and for at most fourteen days", () => {
    const fourteenDays = new Date(NOW.getTime() + 14 * 24 * 60 * 60_000);
    expect(resolveCreatedScheduleCheck({ ...created, checkUntil: fourteenDays }, NOW)).not.toBeNull();
    expect(code(() => resolveCreatedScheduleCheck({ ...created, checkUntil: new Date(fourteenDays.getTime() + 1) }, NOW)))
      .toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveCreatedScheduleCheck({ ...created, checkUntil: FIRST }, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
  });
});

describe("monitor settings on update", () => {
  const monitor = {
    checkCommand: CHECK,
    checkUntil: new Date("2026-10-30T10:00:00.000Z"),
    executionContext: "conversation" as const,
    nextRunAt: FIRST,
  };
  const recurrence = { interval: 10, kind: "minutely" as const };

  it("keeps an untouched monitor and leaves a plain schedule alone", () => {
    expect(resolveUpdatedScheduleCheck(monitor, {}, recurrence, NOW))
      .toEqual({ checkCommand: CHECK, checkUntil: monitor.checkUntil, commandChanged: false });
    expect(resolveUpdatedScheduleCheck({ ...monitor, checkCommand: null, checkUntil: null }, {}, recurrence, NOW))
      .toEqual({ checkCommand: null, checkUntil: null, commandChanged: false });
  });

  it("turns a wake-up into a monitor only together with its window", () => {
    const plain = { ...monitor, checkCommand: null, checkUntil: null };
    expect(resolveUpdatedScheduleCheck(plain, { checkCommand: CHECK, checkUntil: monitor.checkUntil }, recurrence, NOW))
      .toEqual({ checkCommand: CHECK, checkUntil: monitor.checkUntil, commandChanged: true });
    expect(code(() => resolveUpdatedScheduleCheck(plain, { checkCommand: CHECK }, recurrence, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveUpdatedScheduleCheck(plain, { checkUntil: monitor.checkUntil }, recurrence, NOW)))
      .toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveUpdatedScheduleCheck({ ...plain, executionContext: "isolated" }, {
      checkCommand: CHECK, checkUntil: monitor.checkUntil,
    }, recurrence, NOW))).toBe("AGENT_SCHEDULE_CHECK_INVALID");
  });

  it("marks a replaced script, so its failure count starts over", () => {
    expect(resolveUpdatedScheduleCheck(monitor, { checkCommand: `${CHECK} -i` }, recurrence, NOW).commandChanged).toBe(true);
    expect(resolveUpdatedScheduleCheck(monitor, { checkCommand: CHECK }, recurrence, NOW).commandChanged).toBe(false);
  });

  it("refuses a faster recurrence or a next check past the window", () => {
    expect(code(() => resolveUpdatedScheduleCheck(monitor, {}, { interval: 2, kind: "minutely" }, NOW)))
      .toBe("AGENT_SCHEDULE_CHECK_INVALID");
    expect(code(() => resolveUpdatedScheduleCheck(monitor, { nextRunAt: new Date("2026-10-31T10:00:00.000Z") }, recurrence, NOW)))
      .toBe("AGENT_SCHEDULE_CHECK_INVALID");
  });

  it("refuses to resume a monitor whose window has closed", () => {
    expect(() => requireMonitorWindowOpen(monitor.checkUntil, NOW)).not.toThrow();
    expect(() => requireMonitorWindowOpen(null, NOW)).not.toThrow();
    expect(code(() => requireMonitorWindowOpen(new Date("2026-10-27T09:59:59.000Z"), NOW))).toBe("AGENT_SCHEDULE_CHECK_WINDOW_CLOSED");
  });
});
