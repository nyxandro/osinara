/**
 * When the bot asks again about a timezone it does not know (#451).
 *
 * Constructs covered:
 * - The first follow-up about three hours after the request, moved out of the night of the
 *   suggested zone, or a short one when the reminder is close; none when it is too close.
 * - The second one at nine in the morning of the reminder's day, an hour after the first at least.
 * - A one-time wait ends when its clock time has passed in every zone; a repeating one after a week.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { instantToLocal } from "../calendar-mirror/calendar-mirror-local-time.js";
import { followupSchedule, localToInstant } from "./reminder-timezone-followup-schedule.js";

const MOSCOW = "Europe/Moscow";
const minutes = (count: number) => count * 60_000;

describe("followupSchedule", () => {
  it("asks three hours later and again at nine on the reminder's day", () => {
    // Tuesday 10:53 Moscow, the reminder on Thursday at 12:20.
    const schedule = followupSchedule({
      fromGroup: false,
      localFirstRun: "2026-11-05T12:20:00",
      recurring: false,
      requestedAt: new Date("2026-11-03T07:53:00Z"),
      suggestedTimezone: MOSCOW,
    });
    expect(schedule.first?.toISOString()).toBe("2026-11-03T10:53:00.000Z");
    expect(schedule.second?.toISOString()).toBe("2026-11-05T06:00:00.000Z");
    // 12:20 read at UTC−12, the latest any zone can be.
    expect(schedule.expiresAt.toISOString()).toBe("2026-11-06T00:20:00.000Z");
  });

  it("moves a first follow-up that falls at night to eight in the morning", () => {
    const schedule = followupSchedule({
      fromGroup: false,
      localFirstRun: "2026-11-07T18:00:00",
      recurring: false,
      requestedAt: new Date("2026-11-03T20:30:00Z"), // 23:30 Moscow
      suggestedTimezone: MOSCOW,
    });
    expect(schedule.first?.toISOString()).toBe("2026-11-04T05:00:00.000Z");
  });

  it("asks once fifteen minutes later when the reminder is under three hours away", () => {
    const requestedAt = new Date("2026-11-03T09:00:00Z"); // 12:00 Moscow
    const schedule = followupSchedule({
      fromGroup: false,
      localFirstRun: "2026-11-03T12:40:00",
      recurring: false,
      requestedAt,
      suggestedTimezone: MOSCOW,
    });
    expect(schedule.first?.getTime()).toBe(requestedAt.getTime() + minutes(15));
    expect(schedule.second).toBeNull();
  });

  it("does not ask again when the reminder is twenty minutes away", () => {
    const schedule = followupSchedule({
      fromGroup: false,
      localFirstRun: "2026-11-03T12:20:00",
      recurring: false,
      requestedAt: new Date("2026-11-03T09:00:00Z"),
      suggestedTimezone: MOSCOW,
    });
    expect(schedule).toMatchObject({ first: null, second: null });
  });

  it("writes to the private chat within a minute for a request made in the family group", () => {
    const requestedAt = new Date("2026-11-03T09:00:00Z");
    const schedule = followupSchedule({
      fromGroup: true,
      localFirstRun: "2026-11-08T10:00:00",
      recurring: false,
      requestedAt,
      suggestedTimezone: MOSCOW,
    });
    expect(schedule.first?.getTime()).toBe(requestedAt.getTime() + minutes(1));
    expect(schedule.second?.toISOString()).toBe("2026-11-08T06:00:00.000Z");
  });

  it("keeps a repeating wait for a week", () => {
    const requestedAt = new Date("2026-11-03T09:00:00Z");
    const schedule = followupSchedule({
      fromGroup: false,
      localFirstRun: "2026-11-04T09:00:00",
      recurring: true,
      requestedAt,
      suggestedTimezone: MOSCOW,
    });
    expect(schedule.expiresAt.toISOString()).toBe("2026-11-10T09:00:00.000Z");
  });

  it("never asks at night, after the reminder, more than twice or twice within an hour", () => {
    const zones = fc.constantFrom(MOSCOW, "Asia/Vladivostok", "America/New_York", "Europe/Kaliningrad", "Asia/Yerevan");
    const requested = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) });
    const ahead = fc.integer({ min: -24 * 60, max: 30 * 24 * 60 });
    fc.assert(fc.property(zones, requested, ahead, fc.boolean(), fc.boolean(), (zone, at, aheadMinutes, fromGroup, recurring) => {
      const requestedAt = new Date(at - (at % 60_000));
      const localFirstRun = instantToLocal(new Date(requestedAt.getTime() + minutes(aheadMinutes)), zone).slice(0, 16) + ":00";
      const reminderAt = localToInstant(localFirstRun, zone);
      const schedule = followupSchedule({ fromGroup, localFirstRun, recurring, requestedAt, suggestedTimezone: zone });
      if (schedule.first !== null) {
        expect(schedule.first.getTime()).toBeGreaterThanOrEqual(requestedAt.getTime());
        expect(schedule.first.getTime()).toBeLessThanOrEqual(reminderAt.getTime() - minutes(10));
        const short = [minutes(1), minutes(15)].includes(schedule.first.getTime() - requestedAt.getTime());
        const hour = Number(instantToLocal(schedule.first, zone).slice(11, 13));
        if (!short) expect(hour >= 8 && hour < 22).toBe(true);
      }
      if (schedule.second !== null) {
        expect(schedule.first).not.toBeNull();
        expect(schedule.second.getTime()).toBeGreaterThanOrEqual(schedule.first!.getTime() + minutes(60));
        expect(schedule.second.getTime()).toBeLessThan(reminderAt.getTime());
        expect(instantToLocal(schedule.second, zone).slice(11, 16)).toBe("09:00");
      }
      if (!recurring) expect(schedule.expiresAt.getTime()).toBeGreaterThanOrEqual(reminderAt.getTime());
    }), { numRuns: 500 });
  });
});

describe("localToInstant", () => {
  it("reads a wall-clock time in a zone, across daylight saving changes", () => {
    expect(localToInstant("2026-11-04T12:20:00", MOSCOW).toISOString()).toBe("2026-11-04T09:20:00.000Z");
    expect(localToInstant("2026-07-01T12:00:00", "America/New_York").toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(localToInstant("2026-12-01T12:00:00", "America/New_York").toISOString()).toBe("2026-12-01T17:00:00.000Z");
  });
});
