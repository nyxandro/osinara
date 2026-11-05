/**
 * When the bot asks again about a timezone it does not know (#451).
 *
 * Exports:
 * - `localToInstant`: the instant a wall-clock time `YYYY-MM-DDTHH:MM:SS` names in an IANA zone.
 * - `followupSchedule`: the moments of at most two follow-ups and the end of the wait.
 *
 * The person's own zone is unknown, so the reminder's moment and the night are read in the
 * suggested zone: the family's or the product's. The first follow-up comes about three hours after
 * the request, out of the night; when the reminder is closer, one quick follow-up, and none when even
 * that does not fit. The second comes at nine on the reminder's day, an hour after the first at
 * least. A one-time wait ends when its clock time has passed in every zone, a repeating one after a
 * week, both without guessing the zone.
 */
import { addLocalDays, instantToLocal, localParts } from "../calendar-mirror/calendar-mirror-local-time.js";
import {
  REMINDER_TZ_FOLLOWUP_DELAY_MINUTES,
  REMINDER_TZ_FOLLOWUP_GROUP_DELAY_MINUTES,
  REMINDER_TZ_FOLLOWUP_MARGIN_MINUTES,
  REMINDER_TZ_FOLLOWUP_MIN_GAP_MINUTES,
  REMINDER_TZ_FOLLOWUP_SHORT_DELAY_MINUTES,
  REMINDER_TZ_LATEST_ZONE,
  REMINDER_TZ_MORNING_HOUR,
  REMINDER_TZ_NIGHT_END_HOUR,
  REMINDER_TZ_NIGHT_START_HOUR,
  REMINDER_TZ_REPEATING_WAIT_DAYS,
} from "./reminder-config.js";

const MINUTE = 60_000;

export interface FollowupScheduleInput {
  /** A request made in the family group is asked about in the private chat at once. */
  fromGroup: boolean;
  /** The clock time the person named, `YYYY-MM-DDTHH:MM:SS`. */
  localFirstRun: string;
  recurring: boolean;
  requestedAt: Date;
  suggestedTimezone: string;
}

export interface FollowupSchedule {
  expiresAt: Date;
  first: Date | null;
  second: Date | null;
}

function epochOfLocal(local: string): number {
  const parts = localParts(local);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * Two passes of the zone offset settle every ordinary time; a clock time skipped by a daylight
 * saving change resolves to the later offset, the way PostgreSQL moves it forward.
 */
export function localToInstant(local: string, timeZone: string): Date {
  const wall = epochOfLocal(local);
  const firstOffset = epochOfLocal(instantToLocal(new Date(wall), timeZone)) - wall;
  const guess = wall - firstOffset;
  const secondOffset = epochOfLocal(instantToLocal(new Date(guess), timeZone)) - guess;
  return new Date(wall - secondOffset);
}

function localHour(instant: Date, timeZone: string): number {
  return localParts(instantToLocal(instant, timeZone)).hour;
}

/**
 * The moment itself, or the end of the night it falls in, in the given zone. The next morning is the
 * next calendar day by the clock, not 24 hours on: a night across a daylight saving change is 23 or
 * 25 hours long.
 */
function outOfNight(instant: Date, timeZone: string): Date {
  const hour = localHour(instant, timeZone);
  if (hour >= REMINDER_TZ_NIGHT_END_HOUR && hour < REMINDER_TZ_NIGHT_START_HOUR) return instant;
  const today = `${instantToLocal(instant, timeZone).slice(0, 10)}T00:00:00`;
  const day = (hour >= REMINDER_TZ_NIGHT_START_HOUR ? addLocalDays(today, 1) : today).slice(0, 10);
  return localToInstant(`${day}T${String(REMINDER_TZ_NIGHT_END_HOUR).padStart(2, "0")}:00:00`, timeZone);
}

function firstFollowup(input: FollowupScheduleInput, reminderAt: Date): Date | null {
  const latest = reminderAt.getTime() - REMINDER_TZ_FOLLOWUP_MARGIN_MINUTES * MINUTE;
  const requested = input.requestedAt.getTime();
  const usual = input.fromGroup
    ? new Date(requested + REMINDER_TZ_FOLLOWUP_GROUP_DELAY_MINUTES * MINUTE)
    : outOfNight(new Date(requested + REMINDER_TZ_FOLLOWUP_DELAY_MINUTES * MINUTE), input.suggestedTimezone);
  if (usual.getTime() <= latest) return usual;
  const quick = requested + (input.fromGroup
    ? REMINDER_TZ_FOLLOWUP_GROUP_DELAY_MINUTES
    : REMINDER_TZ_FOLLOWUP_SHORT_DELAY_MINUTES) * MINUTE;
  return quick <= latest ? new Date(quick) : null;
}

export function followupSchedule(input: FollowupScheduleInput): FollowupSchedule {
  const reminderAt = localToInstant(input.localFirstRun, input.suggestedTimezone);
  const expiresAt = input.recurring
    ? new Date(input.requestedAt.getTime() + REMINDER_TZ_REPEATING_WAIT_DAYS * 24 * 60 * MINUTE)
    : localToInstant(input.localFirstRun, REMINDER_TZ_LATEST_ZONE);
  const first = firstFollowup(input, reminderAt);
  if (first === null) return { expiresAt, first: null, second: null };
  const morning = localToInstant(
    `${input.localFirstRun.slice(0, 10)}T${String(REMINDER_TZ_MORNING_HOUR).padStart(2, "0")}:00:00`,
    input.suggestedTimezone,
  );
  const second = morning.getTime() >= first.getTime() + REMINDER_TZ_FOLLOWUP_MIN_GAP_MINUTES * MINUTE &&
    morning.getTime() < reminderAt.getTime()
    ? morning
    : null;
  return { expiresAt, first, second };
}
