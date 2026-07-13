/**
 * Google Calendar REST boundary tests.
 *
 * Constructs covered:
 * - Primary calendar identity lookup with bearer authorization.
 * - Safe HTTP, malformed-response, and timeout failures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getGooglePrimaryCalendar } from "./google-calendar-api-client.js";

describe("Google Calendar API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns primary account metadata without exposing the bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessRole: "owner",
      id: "owner@example.com",
      primary: true,
      summary: "owner@example.com",
      timeZone: "Europe/Moscow",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGooglePrimaryCalendar("access-secret")).resolves.toEqual({
      accessRole: "owner",
      id: "owner@example.com",
      summary: "owner@example.com",
      timeZone: "Europe/Moscow",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary",
      expect.objectContaining({
        headers: { authorization: "Bearer access-secret" },
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    new Response(JSON.stringify({ error: { code: 401, message: "raw detail" } }), { status: 401 }),
    new Response("not-json", { status: 200 }),
    new DOMException("timed out", "TimeoutError"),
  ])("fails safely for %s", async (failure) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        failure instanceof Response ? Promise.resolve(failure) : Promise.reject(failure)
      ),
    );
    await expect(getGooglePrimaryCalendar("access-secret")).rejects.toThrow();
  });
});
