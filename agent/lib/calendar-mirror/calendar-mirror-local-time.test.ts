/**
 * Wall-clock helpers of the calendar mirror.
 *
 * Constructs covered:
 * - Instants become local time in the reminder's zone, across a daylight-saving change.
 * - A «last day» or leap-day series starting on a shorter month or year gets the anchor the bot
 *   repeats from, so the bot's runs match Google's.
 */
import { describe, expect, it } from "vitest";

import { instantToLocal, recurrenceAnchor, shiftForQuietHours } from "./calendar-mirror-local-time.js";

describe("instantToLocal", () => {
  it("reads an instant in the reminder's zone", () => {
    expect(instantToLocal(new Date("2027-02-01T07:00:00Z"), "Europe/Moscow")).toBe("2027-02-01T10:00:00");
    expect(instantToLocal(new Date("2027-03-28T05:00:00Z"), "Europe/Berlin")).toBe("2027-03-28T07:00:00");
    expect(instantToLocal(new Date("2027-03-27T06:00:00Z"), "Europe/Berlin")).toBe("2027-03-27T07:00:00");
  });
});

describe("recurrenceAnchor", () => {
  it.each([
    ["2027-02-28T10:00:00", { day: 31, month: 2, unit: "monthly" }, "2027-01-31T10:00:00"],
    ["2027-04-30T10:00:00", { day: 31, month: 4, unit: "monthly" }, "2027-03-31T10:00:00"],
    ["2027-02-28T10:00:00", { day: 30, month: 2, unit: "monthly" }, "2027-01-30T10:00:00"],
    ["2027-03-31T10:00:00", { day: 31, month: 3, unit: "monthly" }, "2027-03-31T10:00:00"],
    ["2027-02-28T09:00:00", { day: 29, month: 2, unit: "yearly" }, "2024-02-29T09:00:00"],
    ["2028-02-29T09:00:00", { day: 29, month: 2, unit: "yearly" }, "2028-02-29T09:00:00"],
    ["2027-02-15T09:00:00", { day: 15, month: 2, unit: "weekly" }, "2027-02-15T09:00:00"],
  ])("anchors %s with %o at %s", (start, anchor, expected) => {
    expect(recurrenceAnchor(start, anchor)).toBe(expected);
  });
});

describe("shiftForQuietHours", () => {
  it("leaves moments outside quiet hours alone", () => {
    expect(shiftForQuietHours("2027-02-05T12:00:00", { end: "08:00:00", start: "23:00:00" }))
      .toEqual({ crossedMidnight: false, local: "2027-02-05T12:00:00" });
    expect(shiftForQuietHours("2027-02-05T08:00:00", { end: "08:00:00", start: "23:00:00" }))
      .toEqual({ crossedMidnight: false, local: "2027-02-05T08:00:00" });
  });
});
