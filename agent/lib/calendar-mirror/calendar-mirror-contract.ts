/**
 * Shared contracts of the reminder ↔ Google Calendar mirror.
 *
 * Exports:
 * - `CalendarMirrorState`, `CalendarMirrorProfile`, `CalendarMirrorActor`: one link per connected
 *   personal or family Google profile and the member it acts for.
 * - `MirrorReminderSource`: the reminder fields a calendar copy is computed from.
 * - `PushedCopy`, `MirrorCopyRow`: what the bot last wrote to Google and the stored link to an event.
 *
 * Local date-times are wall-clock strings `YYYY-MM-DDTHH:MM:SS` in the reminder's IANA timezone:
 * Google takes them together with a time zone, so no instant arithmetic is needed for a copy.
 */
import type { FamilyRole } from "../family-access.js";
import type { ReminderRecurrenceUnit, ReminderStatus } from "../reminders/reminder-record.js";

export type CalendarMirrorState =
  | "active"
  | "removing"
  | "stopped_access_lost"
  | "stopped_calendar_deleted"
  | "stopped_calendar_refused";

export type CalendarMirrorScope = "family" | "personal";

export interface CalendarMirrorProfile {
  calendarId: string | null;
  calendarMarker: string | null;
  calendarMissingSince: Date | null;
  consecutiveFailures: number;
  externalAccountId: string | null;
  familyId: string;
  integrationAccountId: string | null;
  lastErrorCode: string | null;
  /** The personal profile's owner; null for the family profile. */
  ownerUserId: string | null;
  scope: CalendarMirrorScope;
  state: CalendarMirrorState;
  stopNoticeAt: Date | null;
  syncToken: string | null;
  workspaceId: string;
}

/** The member whose live membership authorizes the profile's Google calls. */
export interface CalendarMirrorActor {
  role: FamilyRole;
  telegramUserId: string;
  userId: string;
}

export interface QuietHours {
  /** `HH:MM:SS`, exclusive. */
  end: string;
  /** `HH:MM:SS`, inclusive; a window with start > end crosses midnight. */
  start: string;
}

export interface MirrorRecurrence {
  interval: number;
  unit: ReminderRecurrenceUnit;
}

export interface MirrorReminderSource {
  /** Local anchor of the recurrence; equals the first run for a one-time reminder. */
  anchorLocal: string;
  /** The reminder text without its reply-button markup. */
  content: string;
  /** Local wall-clock time of the current scheduled run, before quiet hours. */
  dueLocal: string;
  id: string;
  /** Quiet hours of the reminder's author, which delay its delivery. */
  quiet: QuietHours | null;
  recurrence: MirrorRecurrence | null;
  status: ReminderStatus;
  timezone: string;
  updatedAt: Date;
}

/** The calendar copy as the bot last wrote it, kept to tell what a person changed in Google. */
export interface PushedCopy {
  anchorLocal: string;
  recurrence: string[] | null;
  /** Recurrence unit and interval the copy was computed from; a change restarts the series. */
  sourceRecurrence: MirrorRecurrence | null;
  startLocal: string;
  summary: string;
  timeZone: string;
}

export interface MirrorCopyRow {
  etag: string | null;
  eventId: string;
  eventUpdated: Date | null;
  fingerprint: string | null;
  id: string;
  kind: "copy" | "ignored";
  pushed: PushedCopy | null;
  rejectedFingerprint: string | null;
  reminderId: string | null;
  seriesStartLocal: string | null;
  shown: boolean;
}
