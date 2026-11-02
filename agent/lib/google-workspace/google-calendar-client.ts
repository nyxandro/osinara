/**
 * Direct Google Calendar API v3 client for the reminder mirror.
 *
 * Exports:
 * - `createGoogleCalendarClient`: calendar and event calls with an access token of the existing
 *   Google Workspace connection.
 * - `CalendarCallError`: a Google refusal sorted by what the caller does next.
 * - `GoogleCalendarEvent`: the event fields the mirror reads.
 *
 * The mirror runs every minute in the background, so it calls Google directly over HTTPS instead
 * of the `gws` CLI, which starts a one-shot Docker container per command. Sorting follows Google's
 * error guide: rate limits, quota and server errors are temporary; a 410 on a listing asks for a
 * full resync; an event already deleted counts as deleted.
 */
import { GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS } from "./google-workspace-config.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const LIST_PAGE_SIZE = "250";
const TEMPORARY_403_REASONS = new Set(["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded"]);
const SYNC_EXPIRED_REASONS = new Set(["fullSyncRequired", "updatedMinTooLongAgo"]);

export type CalendarCallErrorKind =
  | "auth"
  | "conflict"
  | "gone"
  | "not_found"
  | "rejected"
  | "sync_expired"
  | "transient";

export class CalendarCallError extends Error {
  readonly kind: CalendarCallErrorKind;
  readonly providerStatus: number | null;
  readonly reason: string | null;

  constructor(kind: CalendarCallErrorKind, providerStatus: number | null, reason: string | null) {
    super(`AGENT_GOOGLE_CALENDAR_CALL_FAILED: ${kind} (${providerStatus ?? "network"} ${reason ?? ""})`.trim());
    this.name = "CalendarCallError";
    this.kind = kind;
    this.providerStatus = providerStatus;
    this.reason = reason;
  }
}

export interface GoogleCalendarEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleCalendarEvent {
  description?: string;
  end?: GoogleCalendarEventTime;
  etag?: string;
  extendedProperties?: { private?: Record<string, string> };
  id: string;
  originalStartTime?: GoogleCalendarEventTime;
  recurrence?: string[];
  recurringEventId?: string;
  start?: GoogleCalendarEventTime;
  status?: string;
  summary?: string;
  updated?: string;
}

function sortRefusal(status: number, reason: string | null): CalendarCallErrorKind {
  if (status === 429 || status >= 500) return "transient";
  if (status === 403 && reason !== null && TEMPORARY_403_REASONS.has(reason)) return "transient";
  if (status === 401) return "auth";
  if (status === 404) return "not_found";
  if (status === 410) return reason !== null && SYNC_EXPIRED_REASONS.has(reason) ? "sync_expired" : "gone";
  if (status === 409) return "conflict";
  return "rejected";
}

function encode(id: string): string {
  return encodeURIComponent(id);
}

export function createGoogleCalendarClient(accessToken: string, fetchImplementation: typeof fetch = fetch) {
  async function call<T>(
    method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
    path: string,
    options: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${CALENDAR_API}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
        signal: AbortSignal.timeout(GOOGLE_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS),
      });
    } catch {
      // A lost or timed-out connection says nothing about Google's state; the message may hold the URL.
      throw new CalendarCallError("transient", null, null);
    }
    const text = await response.text();
    if (!response.ok) {
      let reason: string | null = null;
      try {
        const parsed = JSON.parse(text) as { error?: { errors?: Array<{ reason?: unknown }> } };
        const candidate = parsed.error?.errors?.[0]?.reason;
        reason = typeof candidate === "string" ? candidate.slice(0, 100) : null;
      } catch {
        reason = null;
      }
      throw new CalendarCallError(sortRefusal(response.status, reason), response.status, reason);
    }
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CalendarCallError("transient", response.status, "invalid_json");
    }
  }

  async function removed(operation: Promise<unknown>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      if (error instanceof CalendarCallError && (error.kind === "not_found" || error.kind === "gone")) return;
      throw error;
    }
  }

  return {
    /** Each event carries its own zone, so the calendar keeps the account's default one. */
    async insertCalendar(input: { description: string; summary: string }): Promise<{ id: string }> {
      return await call<{ id: string }>("POST", "/calendars", { body: input });
    },

    async findCalendarByMarker(marker: string): Promise<string | null> {
      let pageToken: string | undefined;
      do {
        const page = await call<{ items?: Array<{ description?: string; id: string }>; nextPageToken?: string }>(
          "GET",
          "/users/me/calendarList",
          { query: { maxResults: LIST_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) } },
        );
        const own = page.items?.find((item) => item.description?.includes(marker));
        if (own) return own.id;
        pageToken = page.nextPageToken;
      } while (pageToken);
      return null;
    },

    async deleteCalendar(calendarId: string): Promise<void> {
      await removed(call("DELETE", `/calendars/${encode(calendarId)}`));
    },

    /** Changes since the token, or every event (deleted ones included) when there is no token. */
    async listChanges(calendarId: string, syncToken: string | null): Promise<{ items: GoogleCalendarEvent[]; nextSyncToken: string }> {
      const items: GoogleCalendarEvent[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      do {
        const page = await call<{ items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
          "GET",
          `/calendars/${encode(calendarId)}/events`,
          {
            query: {
              maxResults: LIST_PAGE_SIZE,
              ...(syncToken === null ? { showDeleted: "true" } : { syncToken }),
              ...(pageToken ? { pageToken } : {}),
            },
          },
        );
        items.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
        nextSyncToken = page.nextSyncToken;
      } while (pageToken);
      if (!nextSyncToken) throw new CalendarCallError("rejected", 200, "missing_sync_token");
      return { items, nextSyncToken };
    },

    /** Every live event of the calendar, for removal of the mirror calendar. */
    async listEvents(calendarId: string): Promise<GoogleCalendarEvent[]> {
      const items: GoogleCalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const page = await call<{ items?: GoogleCalendarEvent[]; nextPageToken?: string }>(
          "GET",
          `/calendars/${encode(calendarId)}/events`,
          { query: { maxResults: LIST_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) } },
        );
        items.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return items;
    },

    async insertEvent(calendarId: string, body: Record<string, unknown>): Promise<GoogleCalendarEvent> {
      return await call<GoogleCalendarEvent>("POST", `/calendars/${encode(calendarId)}/events`, { body });
    },

    /** Full replacement: fields left out are cleared, and a deleted event comes back. */
    async updateEvent(calendarId: string, eventId: string, body: Record<string, unknown>): Promise<GoogleCalendarEvent> {
      return await call<GoogleCalendarEvent>("PUT", `/calendars/${encode(calendarId)}/events/${encode(eventId)}`, { body });
    },

    async patchEvent(calendarId: string, eventId: string, body: Record<string, unknown>): Promise<GoogleCalendarEvent> {
      return await call<GoogleCalendarEvent>("PATCH", `/calendars/${encode(calendarId)}/events/${encode(eventId)}`, { body });
    },

    async deleteEvent(calendarId: string, eventId: string): Promise<void> {
      await removed(call("DELETE", `/calendars/${encode(calendarId)}/events/${encode(eventId)}`));
    },
  };
}

export type GoogleCalendarClient = ReturnType<typeof createGoogleCalendarClient>;
