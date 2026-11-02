/**
 * Whether a written reminder appears in Google Calendar, as the model is told.
 *
 * Constructs covered:
 * - Each reason a reminder has no copy is named; a working calendar says `will_appear`.
 * - A failure to read the calendar's state never fails the already written reminder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const stateFor = vi.hoisted(() => vi.fn());
vi.mock("./calendar-mirror-repository.js", () => ({ calendarMirrorRepository: { stateFor } }));

import { calendarCopyOutlook } from "./calendar-mirror-outlook.js";

const AUTH = { familyId: "family-1", userId: "user-1" };
const ONCE = { recurrence: null, scope: "personal" as const, status: "active" as const };

describe("calendarCopyOutlook", () => {
  beforeEach(() => {
    stateFor.mockReset();
  });

  it.each([
    ["will_appear", "active", ONCE],
    ["no_google", null, ONCE],
    ["calendar_stopped", "stopped_access_lost", ONCE],
    ["not_shown_frequent", "active", { ...ONCE, recurrence: { interval: 2, unit: "hourly" as const } }],
    ["paused", "active", { ...ONCE, status: "paused" as const }],
  ])("says %s", async (expected, state, reminder) => {
    stateFor.mockResolvedValue(state);
    await expect(calendarCopyOutlook(AUTH, reminder)).resolves.toBe(expected);
  });

  it("never fails a written reminder when the state cannot be read", async () => {
    stateFor.mockRejectedValue(new Error("database down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(calendarCopyOutlook(AUTH, ONCE)).resolves.toBe("unknown");
    expect(JSON.parse(String(error.mock.calls[0]![0]))).toMatchObject({ code: "AGENT_CALENDAR_MIRROR_OUTLOOK_FAILED" });
    error.mockRestore();
  });
});
