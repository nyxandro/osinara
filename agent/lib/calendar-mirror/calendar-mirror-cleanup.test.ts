/**
 * Removing the mirror calendar from Google when Google is disconnected.
 *
 * Constructs covered:
 * - A calendar holding only the bot's copies is deleted whole.
 * - A calendar where the person keeps own events loses only the copies.
 */
import { describe, expect, it, vi } from "vitest";

import { removeMirrorCalendar } from "./calendar-mirror-cleanup.js";

function client(events: Array<{ id: string; mark?: boolean }>) {
  return {
    deleteCalendar: vi.fn(async () => undefined),
    deleteEvent: vi.fn(async () => undefined),
    listEvents: vi.fn(async () => events.map((event) => ({
      id: event.id,
      ...(event.mark ? { extendedProperties: { private: { osinaraMirror: "1" } } } : {}),
    }))),
  };
}

describe("removeMirrorCalendar", () => {
  it("deletes a calendar that holds only copies", async () => {
    const calendar = client([{ id: "osr1", mark: true }, { id: "adopted", mark: true }]);
    await expect(removeMirrorCalendar(calendar, "mirror")).resolves.toBe("removed");
    expect(calendar.deleteCalendar).toHaveBeenCalledWith("mirror");
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
  });

  it("keeps the calendar with the person's own events and deletes only the copies", async () => {
    const calendar = client([{ id: "osr1", mark: true }, { id: "own" }]);
    await expect(removeMirrorCalendar(calendar, "mirror")).resolves.toBe("kept_with_your_events");
    expect(calendar.deleteCalendar).not.toHaveBeenCalled();
    expect(calendar.deleteEvent).toHaveBeenCalledWith("mirror", "osr1");
    expect(calendar.deleteEvent).toHaveBeenCalledTimes(1);
  });
});
