/**
 * What one mirror cycle of a profile works with.
 *
 * Exports:
 * - `MirrorCycleContext`: the profile, the member it acts for, the guarded calendar, storage,
 *   reminder writes and notices of one cycle, with its counters.
 * - `CalendarMirrorNotice`, `MirrorNotices`: one-time messages to the person about the mirror.
 * - `newCycleStats`: zeroed counters for the cycle's log line.
 */
import type { GoogleCalendarClient } from "../google-workspace/google-calendar-client.js";
import type { CalendarMirrorActor, CalendarMirrorProfile } from "./calendar-mirror-contract.js";
import type { calendarMirrorRepository } from "./calendar-mirror-repository.js";
import type {
  applyCalendarEdit,
  createReminderFromEvent,
  deleteReminderFromCalendar,
} from "./calendar-mirror-reminder-writes.js";

export type MirrorCalendar = Pick<
  GoogleCalendarClient,
  "deleteEvent" | "insertEvent" | "listChanges" | "patchEvent" | "updateEvent"
>;

export type MirrorRepository = Pick<
  typeof calendarMirrorRepository,
  | "copies"
  | "deleteCopy"
  | "hideAllCopies"
  | "insertIgnored"
  | "insertPendingCopy"
  | "mirrorReminders"
  | "moveCopyToEvent"
  | "recordCopyHidden"
  | "recordCopyRejected"
  | "recordCopySeen"
  | "recordCopyWritten"
  | "setSyncToken"
>;

export interface MirrorWrites {
  applyCalendarEdit: typeof applyCalendarEdit;
  createReminderFromEvent: typeof createReminderFromEvent;
  deleteReminderFromCalendar: typeof deleteReminderFromCalendar;
}

export type UnsupportedEditReason = "all_day" | "instance" | "past" | "recurrence";

export type CalendarMirrorNotice =
  | { kind: "access_lost" }
  | { kind: "calendar_deleted" }
  | { kind: "calendar_refused" }
  | { kind: "edit_unsupported"; reason: UnsupportedEditReason; title: string }
  | { kind: "event_unsupported"; title: string }
  | { kind: "settings_missing" };

export interface MirrorNotices {
  send(profile: CalendarMirrorProfile, notice: CalendarMirrorNotice, now: Date): Promise<void>;
}

/**
 * The rest of the profile's work waits for the next minute: the cycle's time or write budget is
 * spent, or the model holds the profile. Not a failure: nothing is counted against the profile.
 */
export class MirrorCycleDeferred extends Error {
  readonly why: "budget" | "busy";

  constructor(why: "budget" | "busy") {
    super(`AGENT_CALENDAR_MIRROR_DEFERRED: ${why}`);
    this.name = "MirrorCycleDeferred";
    this.why = why;
  }
}

/**
 * The calendar itself was deleted in Google: its events all arrived as deleted at once (checked live
 * 2026-11-02, while Google keeps the calendar readable for a further 10-20 minutes). The reminders
 * stay; the mirror stops and offers the calendar back.
 */
export class MirrorCalendarRemoved extends Error {
  constructor(readonly deletedCopies: number) {
    super(`AGENT_CALENDAR_MIRROR_CALENDAR_DELETED: ${deletedCopies} copies deleted at once`);
    this.name = "MirrorCalendarRemoved";
  }
}

export interface CycleStats {
  applied: number;
  created: number;
  deleted: number;
  hidden: number;
  ignored: number;
  pulled: number;
  rejected: number;
  reverted: number;
  written: number;
}

export function newCycleStats(): CycleStats {
  return { applied: 0, created: 0, deleted: 0, hidden: 0, ignored: 0, pulled: 0, rejected: 0, reverted: 0, written: 0 };
}

export interface MirrorCycleContext {
  actor: CalendarMirrorActor;
  calendar: MirrorCalendar;
  calendarId: string;
  notices: MirrorNotices;
  now: Date;
  profile: CalendarMirrorProfile;
  repository: MirrorRepository;
  stats: CycleStats;
  writes: MirrorWrites;
}
