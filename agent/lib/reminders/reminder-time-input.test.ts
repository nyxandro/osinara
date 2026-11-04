/**
 * The three ways a reminder's first run is named (#451).
 *
 * Constructs covered:
 * - A clock time the person named carries no offset and must be a real calendar moment.
 * - A countdown is whole minutes within a year, and only a countdown or a minute or hour repeat
 *   can go without the person's timezone.
 */
import { describe, expect, it } from "vitest";

import { countdownNeedsNoTimezone, parseLocalFirstRun, requireCountdownMinutes } from "./reminder-time-input.js";

describe("parseLocalFirstRun", () => {
  it("keeps the clock time the person named", () => {
    expect(parseLocalFirstRun("2026-11-04T12:20")).toBe("2026-11-04T12:20:00");
  });

  it.each(["2026-11-04T12:20:00+03:00", "2026-11-04T12:20Z", "2026-11-04 12:20", "2026-02-30T10:00", "2026-11-04T24:00", "завтра"])(
    "refuses %s with a hint",
    (raw) => {
      expect(() => parseLocalFirstRun(raw)).toThrowError(/AGENT_REMINDER_LOCAL_TIME_INVALID/);
    },
  );
});

describe("requireCountdownMinutes", () => {
  it("accepts whole minutes within a year", () => {
    expect(requireCountdownMinutes(20)).toBe(20);
    expect(requireCountdownMinutes(525_600)).toBe(525_600);
  });

  it.each([0, -5, 1.5, 525_601, "20"])("refuses %s", (raw) => {
    expect(() => requireCountdownMinutes(raw)).toThrowError(/AGENT_REMINDER_COUNTDOWN_INVALID/);
  });
});

describe("countdownNeedsNoTimezone", () => {
  it("allows a single countdown and minute or hour repeats", () => {
    expect(countdownNeedsNoTimezone(null)).toBe(true);
    expect(countdownNeedsNoTimezone({ interval: 2, unit: "hourly" })).toBe(true);
    expect(countdownNeedsNoTimezone({ interval: 30, unit: "minutely" })).toBe(true);
  });

  it("needs a timezone for a daily or rarer repeat", () => {
    expect(countdownNeedsNoTimezone({ interval: 1, unit: "daily" })).toBe(false);
    expect(countdownNeedsNoTimezone({ interval: 1, unit: "weekly" })).toBe(false);
  });
});
