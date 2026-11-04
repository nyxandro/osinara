/**
 * The three ways a reminder's first run is named (#451).
 *
 * Exports:
 * - `ReminderTimeInput`: an exact moment with its zone, a clock time the person named, or a countdown.
 * - `parseLocalFirstRun`: a clock time `YYYY-MM-DDTHH:MM` without an offset, as a real calendar moment.
 * - `requireCountdownMinutes`: whole minutes from now, within a year.
 * - `countdownNeedsNoTimezone`: whether a countdown with this repeat is exact without the person's zone.
 *
 * A clock time is kept apart from an exact moment so the model never invents an offset for a zone it
 * does not know: «в 12:20» stays 12:20 until the zone is known. Minutes and hours repeat as elapsed
 * time, so a countdown with such a repeat is exact anywhere; days and longer follow the calendar of
 * a zone and need one.
 */
import { AppError } from "../app-error.js";
import { REMINDER_COUNTDOWN_MAX_MINUTES } from "./reminder-config.js";
import type { ReminderRecurrence } from "./reminder-record.js";

/**
 * `statedTimezone` is a zone the model passed beside a clock time or a countdown: it must agree with
 * the person's saved zone, and without one it is the model's guess and is not used.
 */
export type ReminderTimeInput =
  | { at: Date; kind: "absolute"; timezone: string }
  | { kind: "local"; local: string; statedTimezone?: string }
  | { kind: "countdown"; minutes: number; statedTimezone?: string };

/** A countdown made without the person's zone is an exact moment and is stored in UTC. */
export const COUNTDOWN_TIMEZONE = "UTC";

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

export function parseLocalFirstRun(raw: string): string {
  const match = LOCAL_PATTERN.exec(raw);
  const [year, month, day, hour, minute] = (match?.slice(1) ?? []).map(Number);
  const real = match !== null && hour! < 24 && minute! < 60 &&
    new Date(Date.UTC(year!, month! - 1, day!)).getUTCDate() === day && month! >= 1 && month! <= 12;
  if (!real) {
    throw new AppError(
      "AGENT_REMINDER_LOCAL_TIME_INVALID",
      "Передайте localFirstRun как дату и время по часам человека без пояса, например 2026-11-04T12:20",
    );
  }
  return `${raw}:00`;
}

export function requireCountdownMinutes(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > REMINDER_COUNTDOWN_MAX_MINUTES) {
    throw new AppError(
      "AGENT_REMINDER_COUNTDOWN_INVALID",
      `Передайте firstRunInMinutes целым числом минут от 1 до ${REMINDER_COUNTDOWN_MAX_MINUTES}`,
    );
  }
  return raw;
}

export function countdownNeedsNoTimezone(recurrence: ReminderRecurrence | null): boolean {
  return recurrence === null || recurrence.unit === "minutely" || recurrence.unit === "hourly";
}
