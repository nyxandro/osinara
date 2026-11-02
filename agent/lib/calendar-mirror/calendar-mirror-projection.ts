/**
 * The Google Calendar copy of a reminder.
 *
 * Exports:
 * - `projectReminderCopy`: the event body the bot keeps in Google, what it records as pushed, and a
 *   fingerprint that changes exactly when the event has to be rewritten.
 * - `mirrorEventId`: the deterministic id of the bot's own event for a reminder.
 * - `HIDDEN_COPY_FINGERPRINT`, `HIDING_COPY_FINGERPRINT`: a copy removed, or being removed, because
 *   the reminder has none now.
 *
 * A copy stands at the moment the message really goes out: the author's quiet hours move it to their
 * end. A series repeats from the start it was first written with while the reminder's anchor and
 * period stay, so a delivery that only advances the next run never rewrites the event.
 */
import { createHash } from "node:crypto";

import type { MirrorCopyRow, MirrorReminderSource, PushedCopy } from "./calendar-mirror-contract.js";
import {
  CALENDAR_MIRROR_COPY_FOOTER,
  CALENDAR_MIRROR_EVENT_ID_PREFIX,
  CALENDAR_MIRROR_EVENT_MINUTES,
  CALENDAR_MIRROR_PRIVATE_MARK,
  CALENDAR_MIRROR_PRIVATE_REMINDER,
} from "./calendar-mirror-config.js";
import { addLocalMinutes, localParts, shiftForQuietHours } from "./calendar-mirror-local-time.js";
import { reminderRecurrenceRule } from "./calendar-mirror-recurrence.js";
import { copyTitle, reminderPlainText } from "./calendar-mirror-text.js";

export interface CalendarEventTime {
  dateTime: string;
  timeZone: string;
}

export interface CalendarEventBody {
  description: string;
  end: CalendarEventTime;
  extendedProperties: { private: Record<string, string> };
  recurrence?: string[];
  reminders: { overrides: []; useDefault: false };
  start: CalendarEventTime;
  status: "confirmed";
  summary: string;
  transparency: "transparent";
}

export type ProjectedCopy =
  | { hidden: true; reason: "failed" | "frequent" | "paused" }
  | {
    body: CalendarEventBody;
    fingerprint: string;
    hidden: false;
    pushed: PushedCopy;
    /** Unshifted local start the series repeats from; null for a one-time copy. */
    seriesStartLocal: string | null;
  };

export const HIDDEN_COPY_FINGERPRINT = createHash("sha256").update("calendar-mirror:hidden").digest("hex");
/** Recorded before the bot removes an event, so the removal is known as its own even if cut off. */
export const HIDING_COPY_FINGERPRINT = createHash("sha256").update("calendar-mirror:hiding").digest("hex");

export function mirrorEventId(reminderId: string): string {
  return `${CALENDAR_MIRROR_EVENT_ID_PREFIX}${reminderId.replaceAll("-", "").toLowerCase()}`;
}

function sameRecurrence(left: PushedCopy["sourceRecurrence"], right: MirrorReminderSource["recurrence"]): boolean {
  return left?.unit === right?.unit && left?.interval === right?.interval;
}

/** The kept series start, unless the reminder's anchor or period changed since it was written. */
function seriesStart(source: MirrorReminderSource, previous: Pick<MirrorCopyRow, "pushed" | "seriesStartLocal"> | null): string {
  const kept = previous?.seriesStartLocal ?? null;
  const pushed = previous?.pushed ?? null;
  return kept !== null && pushed !== null && pushed.anchorLocal === source.anchorLocal &&
    sameRecurrence(pushed.sourceRecurrence, source.recurrence)
    ? kept
    : source.dueLocal;
}

/**
 * Quiet hours moving a month-end or leap-day series past midnight land on a day no RRULE can name
 * (the 28th of February becomes the 1st of March), so such a copy shows only the nearest run.
 */
function needsNearestRunOnly(source: MirrorReminderSource, crossedMidnight: boolean): boolean {
  if (!crossedMidnight || source.recurrence === null) return false;
  const anchor = localParts(source.anchorLocal);
  if (source.recurrence.unit === "monthly") return anchor.day >= 28;
  if (source.recurrence.unit === "yearly") return anchor.month === 2 && anchor.day >= 28;
  return false;
}

export function projectReminderCopy(
  source: MirrorReminderSource,
  options: { previous: Pick<MirrorCopyRow, "pushed" | "seriesStartLocal"> | null },
): ProjectedCopy {
  if (source.status === "paused") return { hidden: true, reason: "paused" };
  if (source.status === "failed") return { hidden: true, reason: "failed" };
  const unit = source.recurrence?.unit;
  if (unit === "minutely" || unit === "hourly") return { hidden: true, reason: "frequent" };

  const nominal = source.recurrence === null ? source.dueLocal : seriesStart(source, options.previous);
  const shifted = shiftForQuietHours(nominal, source.quiet);
  const nearestOnly = needsNearestRunOnly(source, shifted.crossedMidnight);
  const start = nearestOnly ? shiftForQuietHours(source.dueLocal, source.quiet).local : shifted.local;
  const rule = source.recurrence === null || nearestOnly
    ? null
    : reminderRecurrenceRule(source.recurrence, shifted.crossedMidnight ? start : source.anchorLocal);
  const summary = copyTitle(source.content);
  const body: CalendarEventBody = {
    description: `${reminderPlainText(source.content)}\n\n${CALENDAR_MIRROR_COPY_FOOTER}`,
    end: { dateTime: addLocalMinutes(start, CALENDAR_MIRROR_EVENT_MINUTES), timeZone: source.timezone },
    extendedProperties: {
      private: { [CALENDAR_MIRROR_PRIVATE_MARK]: "1", [CALENDAR_MIRROR_PRIVATE_REMINDER]: source.id },
    },
    ...(rule === null ? {} : { recurrence: rule }),
    reminders: { overrides: [], useDefault: false },
    start: { dateTime: start, timeZone: source.timezone },
    status: "confirmed",
    summary,
    transparency: "transparent",
  };
  return {
    body,
    fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    hidden: false,
    pushed: {
      anchorLocal: source.anchorLocal,
      recurrence: rule,
      sourceRecurrence: source.recurrence,
      startLocal: start,
      summary,
      timeZone: source.timezone,
    },
    seriesStartLocal: source.recurrence === null || nearestOnly ? null : nominal,
  };
}
