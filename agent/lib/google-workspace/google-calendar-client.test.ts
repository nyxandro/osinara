/**
 * Direct Google Calendar API client of the reminder mirror.
 *
 * Constructs covered:
 * - Requests carry the bearer token, exact paths and bodies; calendar ids are URL-encoded.
 * - Google answers are sorted into what the mirror does next: wait, reconnect, recreate, resync,
 *   overwrite or give up on one event; the token never reaches a log or an error.
 * - Change listing pages through results and asks for deleted events only on a full listing.
 */
import { describe, expect, it, vi } from "vitest";

import { CalendarCallError, createGoogleCalendarClient } from "./google-calendar-client.js";

const TOKEN = "ya29.secret-access-token";

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function googleError(status: number, reason: string): Response {
  return reply(status, { error: { code: status, errors: [{ reason }], message: `Google ${reason}` } });
}

function clientWith(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  return { client: createGoogleCalendarClient(TOKEN, fetchMock), fetchMock };
}

describe("google calendar client", () => {
  it("replaces an event with the token, encoded calendar id and full body", async () => {
    const { client, fetchMock } = clientWith(reply(200, { etag: "\"e1\"", id: "osr1", status: "confirmed" }));
    const event = await client.updateEvent("cal/1@group.calendar.google.com", "osr1", { summary: "🔔 Банк" });
    expect(event).toMatchObject({ etag: "\"e1\"", id: "osr1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://www.googleapis.com/calendar/v3/calendars/cal%2F1%40group.calendar.google.com/events/osr1");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ summary: "🔔 Банк" });
  });

  it.each([
    [googleError(429, "rateLimitExceeded"), "transient"],
    [googleError(500, "backendError"), "transient"],
    [googleError(503, "backendError"), "transient"],
    [googleError(403, "rateLimitExceeded"), "transient"],
    [googleError(403, "userRateLimitExceeded"), "transient"],
    [googleError(403, "quotaExceeded"), "transient"],
    [googleError(401, "authError"), "auth"],
    [googleError(404, "notFound"), "not_found"],
    [googleError(410, "deleted"), "gone"],
    [googleError(410, "fullSyncRequired"), "sync_expired"],
    [googleError(409, "duplicate"), "conflict"],
    [googleError(400, "invalid"), "rejected"],
    [googleError(403, "forbiddenForNonOrganizer"), "rejected"],
  ])("sorts %#: %s", async (response, kind) => {
    const { client } = clientWith(response as Response);
    const error = await client.updateEvent("cal", "osr1", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CalendarCallError);
    expect(error).toMatchObject({ kind });
  });

  it("treats a lost connection as a temporary failure without leaking the token", async () => {
    const { client } = clientWith(new TypeError(`fetch failed for ${TOKEN}`));
    const error = await client.updateEvent("cal", "osr1", {}).catch((caught: unknown) => caught) as CalendarCallError;
    expect(error).toMatchObject({ kind: "transient", providerStatus: null });
    expect(JSON.stringify({ message: error.message, reason: error.reason })).not.toContain(TOKEN);
  });

  it("counts an already removed event as removed", async () => {
    const { client } = clientWith(googleError(410, "deleted"), googleError(404, "notFound"), reply(204));
    await expect(client.deleteEvent("cal", "osr1")).resolves.toBeUndefined();
    await expect(client.deleteEvent("cal", "osr1")).resolves.toBeUndefined();
    await expect(client.deleteEvent("cal", "osr1")).resolves.toBeUndefined();
  });

  it("lists changes page by page and returns the next sync token", async () => {
    const { client, fetchMock } = clientWith(
      reply(200, { items: [{ id: "a" }], nextPageToken: "page-2" }),
      reply(200, { items: [{ id: "b" }], nextSyncToken: "sync-2" }),
    );
    const changes = await client.listChanges("cal", "sync-1");
    expect(changes).toEqual({ items: [{ id: "a" }, { id: "b" }], nextSyncToken: "sync-2" });
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get("syncToken")).toBe("sync-1");
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get("showDeleted")).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get("pageToken")).toBe("page-2");
  });

  it("asks for deleted events on a full listing", async () => {
    const { client, fetchMock } = clientWith(reply(200, { items: [], nextSyncToken: "sync-1" }));
    await client.listChanges("cal", null);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("showDeleted")).toBe("true");
    expect(url.searchParams.get("syncToken")).toBeNull();
  });

  it("refuses a listing that ends without a sync token", async () => {
    const { client } = clientWith(reply(200, { items: [] }));
    await expect(client.listChanges("cal", null)).rejects.toMatchObject({ kind: "rejected" });
  });

  it("finds its own calendar by the marker in the description across pages", async () => {
    const { client } = clientWith(
      reply(200, { items: [{ description: "чужой", id: "other" }], nextPageToken: "p2" }),
      reply(200, { items: [{ description: "текст\n\nosinara-mirror:w1:abc", id: "own" }] }),
    );
    await expect(client.findCalendarByMarker("osinara-mirror:w1:abc")).resolves.toBe("own");
  });
});
