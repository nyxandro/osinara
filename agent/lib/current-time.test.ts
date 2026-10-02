/**
 * Current-time context and model-facing tool tests.
 *
 * Constructs covered:
 * - `formatCurrentTimeContext`: emits a trusted turn-start UTC snapshot.
 * - `get_current_time`: returns configured or explicitly requested local civil time.
 * - Invalid IANA timezones fail with a stable actionable error.
 */
import type { ToolContext } from "../runtime/tool.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  findUserTimezone: vi.fn(),
  requireReminderAuthorization: vi.fn(() => ({
    familyId: "family-1",
    userId: "user-1",
  })),
}));

vi.mock("./current-time-repository.js", () => ({
  currentTimeRepository: { findUserTimezone: dependencies.findUserTimezone },
}));
vi.mock("./reminders/reminder-context.js", () => ({
  requireReminderAuthorization: dependencies.requireReminderAuthorization,
}));

import getCurrentTime from "./tools/get_current_time.js";
import { formatCurrentTimeContext } from "./current-time.js";

const context = { callId: "call-1", session: { auth: { current: null } } } as ToolContext;

describe("formatCurrentTimeContext", () => {
  it("formats an unambiguous turn-start UTC snapshot", () => {
    expect(formatCurrentTimeContext(new Date("2026-07-30T15:24:18.000Z"))).toBe([
      "<current_time>",
      "captured_at_utc: 2026-07-30T15:24:18.000Z",
      "precision: turn_start",
      "</current_time>",
    ].join("\n"));
  });
});

describe("get_current_time", () => {
  it.each([false, true])("uses group time without a personal account (child=%s)", async (child) => {
    const external = {
      ...context,
      parent: child ? { session: { id: "parent" } } : null,
      session: { auth: { current: {
        attributes: { groupType: "external", memoryScopes: ["group"] },
        principalType: "service", principalId: "telegram-bot-1",
      } } },
    } as unknown as ToolContext;
    await expect(getCurrentTime.execute({}, external)).resolves.toMatchObject({
      capturedAtUtc: "2026-07-30T15:24:18.000Z", localTime: "18:24:18",
      timezone: "Europe/Moscow", timezoneSource: "group_config",
    });
    await expect(getCurrentTime.execute({ timezone: "Asia/Tokyo" }, external)).resolves.toMatchObject({
      localTime: "00:24:18", timezoneSource: "explicit",
    });
    expect(dependencies.requireReminderAuthorization).not.toHaveBeenCalled();
    expect(dependencies.findUserTimezone).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T15:24:18.000Z"));
    dependencies.findUserTimezone.mockReset();
    dependencies.requireReminderAuthorization.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns current civil time in the configured user timezone", async () => {
    dependencies.findUserTimezone.mockResolvedValue("Europe/Moscow");

    await expect(getCurrentTime.execute({}, context)).resolves.toEqual({
      capturedAtUtc: "2026-07-30T15:24:18.000Z",
      localDate: "2026-07-30",
      localTime: "18:24:18",
      timezone: "Europe/Moscow",
      timezoneSource: "user_settings",
      utcOffset: "+03:00",
      weekday: "четверг",
    });
  });

  it("uses an explicit IANA timezone without reading user settings", async () => {
    await expect(getCurrentTime.execute({ timezone: "Asia/Tokyo" }, context)).resolves.toEqual({
      capturedAtUtc: "2026-07-30T15:24:18.000Z",
      localDate: "2026-07-31",
      localTime: "00:24:18",
      timezone: "Asia/Tokyo",
      timezoneSource: "explicit",
      utcOffset: "+09:00",
      weekday: "пятница",
    });
    expect(dependencies.findUserTimezone).not.toHaveBeenCalled();
  });

  it("returns UTC without inventing local time when timezone is not configured", async () => {
    dependencies.findUserTimezone.mockResolvedValue(null);

    await expect(getCurrentTime.execute({}, context)).resolves.toEqual({
      capturedAtUtc: "2026-07-30T15:24:18.000Z",
      localDate: null,
      localTime: null,
      timezone: null,
      timezoneSource: "not_configured",
      utcOffset: null,
      weekday: null,
    });
  });

  it("rejects an unknown timezone with a stable error", async () => {
    await expect(
      getCurrentTime.execute({ timezone: "Mars/Olympus" }, context),
    ).rejects.toThrowError(
      "AGENT_CURRENT_TIME_TIMEZONE_INVALID: Укажите корректный IANA timezone, например Europe/Moscow",
    );
    expect(dependencies.findUserTimezone).not.toHaveBeenCalled();
  });
});
