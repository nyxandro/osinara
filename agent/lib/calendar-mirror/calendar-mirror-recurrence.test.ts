/**
 * Recurrence translation between reminders and Google Calendar.
 *
 * Constructs covered:
 * - Every reminder period maps to the RRULE verified against live Google (month ends, leap day).
 * - Rules a person sets in Google are accepted only when the bot repeats exactly the same way.
 */
import { describe, expect, it } from "vitest";

import { parseGoogleRecurrence, reminderRecurrenceRule } from "./calendar-mirror-recurrence.js";

describe("reminderRecurrenceRule", () => {
  it.each([
    [{ interval: 1, unit: "daily" as const }, "2027-01-15T10:00:00", "RRULE:FREQ=DAILY;INTERVAL=1"],
    [{ interval: 2, unit: "weekly" as const }, "2027-01-15T10:00:00", "RRULE:FREQ=WEEKLY;INTERVAL=2"],
    [{ interval: 1, unit: "monthly" as const }, "2027-01-28T10:00:00", "RRULE:FREQ=MONTHLY;INTERVAL=1"],
    [{ interval: 1, unit: "monthly" as const }, "2027-01-29T10:00:00", "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=28,29;BYSETPOS=-1"],
    [{ interval: 3, unit: "monthly" as const }, "2027-01-30T10:00:00", "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=28,29,30;BYSETPOS=-1"],
    [{ interval: 2, unit: "monthly" as const }, "2027-01-31T10:00:00", "RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=28,29,30,31;BYSETPOS=-1"],
    [{ interval: 1, unit: "yearly" as const }, "2027-03-08T09:00:00", "RRULE:FREQ=YEARLY;INTERVAL=1"],
    [{ interval: 1, unit: "yearly" as const }, "2028-02-29T09:00:00", "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1"],
  ])("maps %o anchored at %s", (recurrence, anchor, rule) => {
    expect(reminderRecurrenceRule(recurrence, anchor)).toEqual([rule]);
  });

  it("has no rule for repeats every few minutes or hours", () => {
    expect(reminderRecurrenceRule({ interval: 10, unit: "minutely" }, "2027-01-15T10:00:00")).toBeNull();
    expect(reminderRecurrenceRule({ interval: 2, unit: "hourly" }, "2027-01-15T10:00:00")).toBeNull();
  });
});

describe("parseGoogleRecurrence", () => {
  it("reads no recurrence as a one-time event", () => {
    expect(parseGoogleRecurrence(undefined, "2027-02-01T10:00:00")).toEqual({ kind: "none" });
    expect(parseGoogleRecurrence([], "2027-02-01T10:00:00")).toEqual({ kind: "none" });
  });

  it.each([
    [["RRULE:FREQ=DAILY"], "2027-02-01T10:00:00", { interval: 1, unit: "daily" }, 1, 2],
    [["RRULE:FREQ=WEEKLY;BYDAY=MO"], "2027-02-01T10:00:00", { interval: 1, unit: "weekly" }, 1, 2],
    [["RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=MO"], "2027-02-01T10:00:00", { interval: 2, unit: "weekly" }, 1, 2],
    [["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"], "2027-02-15T10:00:00", { interval: 1, unit: "monthly" }, 15, 2],
    [["RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=28,29,30,31;BYSETPOS=-1"], "2027-02-28T10:00:00", { interval: 2, unit: "monthly" }, 31, 2],
    [["RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1"], "2027-02-28T10:00:00", { interval: 1, unit: "monthly" }, 30, 2],
    [["RRULE:FREQ=YEARLY"], "2027-03-08T09:00:00", { interval: 1, unit: "yearly" }, 8, 3],
    [["RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8"], "2027-03-08T09:00:00", { interval: 1, unit: "yearly" }, 8, 3],
    [["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1"], "2027-02-28T09:00:00", { interval: 1, unit: "yearly" }, 29, 2],
  ])("accepts %o starting %s", (lines, start, recurrence, anchorDay, anchorMonth) => {
    expect(parseGoogleRecurrence(lines, start)).toEqual({ anchorDay, anchorMonth, kind: "supported", recurrence });
  });

  it.each([
    [["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"], "2027-02-02T10:00:00"],
    [["RRULE:FREQ=WEEKLY;BYDAY=TU"], "2027-02-01T10:00:00"],
    [["RRULE:FREQ=MONTHLY;BYDAY=3TU"], "2027-02-16T10:00:00"],
    [["RRULE:FREQ=WEEKLY;UNTIL=20270301T000000Z"], "2027-02-01T10:00:00"],
    [["RRULE:FREQ=DAILY;COUNT=5"], "2027-02-01T10:00:00"],
    [["RRULE:FREQ=HOURLY"], "2027-02-01T10:00:00"],
    [["RRULE:FREQ=MONTHLY;BYMONTHDAY=10"], "2027-02-15T10:00:00"],
    [["RRULE:FREQ=DAILY;INTERVAL=400"], "2027-02-01T10:00:00"],
    [["RRULE:FREQ=DAILY", "EXDATE:20270203T100000Z"], "2027-02-01T10:00:00"],
    [["RRULE:FREQ=DAILY", "RRULE:FREQ=WEEKLY"], "2027-02-01T10:00:00"],
  ])("refuses %o starting %s", (lines, start) => {
    expect(parseGoogleRecurrence(lines, start)).toEqual({ kind: "unsupported" });
  });
});
