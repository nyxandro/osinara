/**
 * In-memory stand-ins for one mirror cycle: Google Calendar, mirror storage, reminder writes, notices.
 *
 * Export:
 * - `fakeCycle`: a `MirrorCycleContext` over fakes, with handles to inspect calls and state.
 *
 * The calendar fake behaves like the live API checked on 2026-11-02: a replace of a missing event is
 * 404, an insert under a taken id is 409, a deleted event stays as `cancelled` under its id and
 * every write gives a new etag.
 */
import { vi } from "vitest";

import { CalendarCallError, type GoogleCalendarEvent } from "../google-workspace/google-calendar-client.js";
import type { CalendarMirrorProfile, MirrorCopyRow, MirrorReminderSource } from "./calendar-mirror-contract.js";
import {
  type CalendarMirrorNotice,
  type MirrorCycleContext,
  newCycleStats,
} from "./calendar-mirror-cycle-context.js";

export const PROFILE: CalendarMirrorProfile = {
  calendarId: "mirror@group.calendar.google.com",
  calendarMarker: "osinara-mirror:w1:m1",
  calendarMissingSince: null,
  consecutiveFailures: 0,
  externalAccountId: "google-owner",
  familyId: "family-1",
  integrationAccountId: "account-1",
  lastErrorCode: null,
  ownerUserId: "user-1",
  scope: "personal",
  state: "active",
  stopNoticeAt: null,
  syncToken: "sync-0",
  workspaceId: "workspace-1",
};

export function fakeCalendar() {
  const events = new Map<string, GoogleCalendarEvent>();
  const calls: Array<[string, string]> = [];
  const failures: Array<{ error: CalendarCallError; method: string }> = [];
  let version = 0;
  const changes: { items: GoogleCalendarEvent[]; nextSyncToken: string } = { items: [], nextSyncToken: "sync-1" };

  function failIfAsked(method: string) {
    const index = failures.findIndex((failure) => failure.method === method);
    if (index !== -1) throw failures.splice(index, 1)[0]!.error;
  }
  function stamp(event: Omit<GoogleCalendarEvent, "etag">): GoogleCalendarEvent {
    version += 1;
    const stored = { ...event, etag: `"v${version}"`, updated: `2027-02-03T09:00:${String(version % 60).padStart(2, "0")}Z` };
    events.set(event.id, stored);
    return stored;
  }

  const calendar: MirrorCycleContext["calendar"] = {
    async deleteEvent(_calendarId, eventId) {
      calls.push(["delete", eventId]);
      failIfAsked("delete");
      const event = events.get(eventId);
      if (event) stamp({ id: eventId, status: "cancelled" });
    },
    async insertEvent(_calendarId, body) {
      const id = String(body.id);
      calls.push(["insert", id]);
      failIfAsked("insert");
      if (events.has(id)) throw new CalendarCallError("conflict", 409, "duplicate");
      return stamp({ ...(body as Omit<GoogleCalendarEvent, "etag">), id });
    },
    async listChanges(_calendarId, syncToken) {
      calls.push(["list", syncToken ?? "full"]);
      failIfAsked("list");
      return { items: changes.items, nextSyncToken: changes.nextSyncToken };
    },
    async patchEvent(_calendarId, eventId, body) {
      calls.push(["patch", eventId]);
      failIfAsked("patch");
      return stamp({ ...(events.get(eventId) ?? { id: eventId }), ...(body as object), id: eventId });
    },
    async updateEvent(_calendarId, eventId, body) {
      calls.push(["update", eventId]);
      failIfAsked("update");
      if (!events.has(eventId)) throw new CalendarCallError("not_found", 404, "notFound");
      return stamp({ ...(body as Omit<GoogleCalendarEvent, "etag">), id: eventId });
    },
  };
  return {
    calendar,
    calls,
    changes,
    events,
    fail(method: string, error: CalendarCallError) {
      failures.push({ error, method });
    },
  };
}

export function fakeRepository(input: { copies?: MirrorCopyRow[]; reminders?: MirrorReminderSource[] } = {}) {
  const copies = new Map<string, MirrorCopyRow>((input.copies ?? []).map((copy) => [copy.id, { ...copy }]));
  const reminders = [...(input.reminders ?? [])];
  const state = { syncToken: PROFILE.syncToken as string | null };
  let nextId = 0;

  const repository: MirrorCycleContext["repository"] = {
    async copies() {
      return [...copies.values()].map((copy) => ({ ...copy }));
    },
    async deleteCopy(copyId) {
      copies.delete(copyId);
    },
    async hideAllCopies(_workspaceId, fingerprint) {
      for (const [id, copy] of copies) {
        if (copy.kind === "copy") copies.set(id, { ...copy, fingerprint, pushed: null, seriesStartLocal: null, shown: false });
      }
    },
    async insertIgnored(_workspaceId, eventId, etag, eventUpdated) {
      const existing = [...copies.values()].find((copy) => copy.eventId === eventId);
      const id = existing?.id ?? `copy-${++nextId}`;
      copies.set(id, { ...blankCopy(id, eventId), etag, eventUpdated, kind: "ignored", reminderId: null });
    },
    async insertPendingCopy(_workspaceId, reminderId, eventId) {
      const copy = { ...blankCopy(`copy-${++nextId}`, eventId), reminderId };
      copies.set(copy.id, copy);
      return { ...copy };
    },
    async mirrorReminders() {
      return reminders.map((reminder) => ({ ...reminder }));
    },
    async moveCopyToEvent(copyId, eventId) {
      copies.set(copyId, { ...copies.get(copyId)!, eventId, fingerprint: null });
    },
    async recordCopyHidden(copyId, fingerprint) {
      copies.set(copyId, { ...copies.get(copyId)!, fingerprint, pushed: null, rejectedFingerprint: null, seriesStartLocal: null, shown: false });
    },
    async recordCopyRejected(copyId, fingerprint) {
      copies.set(copyId, { ...copies.get(copyId)!, rejectedFingerprint: fingerprint });
    },
    async recordCopySeen(copyId, etag, eventUpdated) {
      copies.set(copyId, { ...copies.get(copyId)!, etag, eventUpdated });
    },
    async recordCopyWritten(copyId, write) {
      copies.set(copyId, { ...copies.get(copyId)!, ...write, rejectedFingerprint: null });
    },
    async setSyncToken(_workspaceId, syncToken) {
      state.syncToken = syncToken;
    },
  };
  return { copies, reminders, repository, state };
}

export function blankCopy(id: string, eventId: string): MirrorCopyRow {
  return {
    etag: null,
    eventId,
    eventUpdated: null,
    fingerprint: null,
    id,
    kind: "copy",
    pushed: null,
    rejectedFingerprint: null,
    reminderId: null,
    seriesStartLocal: null,
    shown: false,
  };
}

export function reminderSource(overrides: Partial<MirrorReminderSource> = {}): MirrorReminderSource {
  return {
    anchorLocal: "2027-02-05T10:00:00",
    content: "Позвонить в банк",
    dueLocal: "2027-02-05T10:00:00",
    id: "5f0e6a52-6f53-4f39-9d8e-0d7a7b2c1e11",
    quiet: null,
    recurrence: null,
    status: "active",
    timezone: "Europe/Moscow",
    updatedAt: new Date("2027-02-01T00:00:00Z"),
    ...overrides,
  };
}

export function fakeCycle(input: { copies?: MirrorCopyRow[]; reminders?: MirrorReminderSource[] } = {}) {
  const google = fakeCalendar();
  const storage = fakeRepository(input);
  const notices: CalendarMirrorNotice[] = [];
  const writes = {
    applyCalendarEdit: vi.fn<MirrorCycleContext["writes"]["applyCalendarEdit"]>().mockResolvedValue("applied"),
    createReminderFromEvent: vi.fn<MirrorCycleContext["writes"]["createReminderFromEvent"]>().mockResolvedValue({ reminderId: "new-reminder" }),
    deleteReminderFromCalendar: vi.fn<MirrorCycleContext["writes"]["deleteReminderFromCalendar"]>().mockResolvedValue("deleted"),
  };
  const context: MirrorCycleContext = {
    actor: { role: "owner", telegramUserId: "tg-1", userId: "user-1" },
    calendar: google.calendar,
    calendarId: PROFILE.calendarId!,
    notices: { send: async (_profile, notice) => { notices.push(notice); } },
    now: new Date("2027-02-03T09:00:00Z"),
    profile: PROFILE,
    repository: storage.repository,
    stats: newCycleStats(),
    writes,
  };
  return { context, google, notices, storage, writes };
}
