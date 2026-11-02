/**
 * Wall-clock arithmetic on local date-times `YYYY-MM-DDTHH:MM:SS`.
 *
 * Exports:
 * - `shiftForQuietHours`: the local moment a reminder really goes out, as the dispatcher delays it.
 * - `addLocalMinutes`, `addLocalDays`, `localParts`, `localWeekday`, `daysInMonth`, `formatLocal`.
 *
 * The values carry no time zone: Google receives them with the reminder's IANA zone, and the bot's
 * own calendar recurrence is wall-clock too, so plain calendar arithmetic in UTC fields is exact.
 */
import type { QuietHours } from "./calendar-mirror-contract.js";

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface LocalParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}

export function localParts(local: string): LocalParts {
  const match = LOCAL_PATTERN.exec(local);
  if (!match) throw new Error(`AGENT_CALENDAR_MIRROR_LOCAL_TIME_INVALID: ${local}`);
  const [, year, month, day, hour, minute, second] = match.map(Number) as number[];
  return { day: day!, hour: hour!, minute: minute!, month: month!, second: second!, year: year! };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function fromEpoch(milliseconds: number): string {
  const date = new Date(milliseconds);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function toEpoch(local: string): number {
  const parts = localParts(local);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

export function formatLocal(parts: LocalParts): string {
  return fromEpoch(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

export function addLocalMinutes(local: string, minutes: number): string {
  return fromEpoch(toEpoch(local) + minutes * 60_000);
}

export function addLocalDays(local: string, days: number): string {
  return addLocalMinutes(local, days * 24 * 60);
}

export function localWeekday(local: string): Weekday {
  return WEEKDAYS[new Date(toEpoch(local)).getUTCDay()]!;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The wall-clock time of an instant in an IANA zone. */
export function instantToLocal(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

/**
 * The bot's recurrence anchor for a series starting at `startLocal`. A «last day of the month» or
 * leap-day rule may start on a shorter month or year; the anchor is then the latest earlier date
 * that has the anchored day, because the bot clamps months and years from the anchor.
 */
export function recurrenceAnchor(startLocal: string, anchor: { day: number; month: number; unit: string }): string {
  const start = localParts(startLocal);
  if (anchor.unit === "monthly" && anchor.day !== start.day) {
    let year = start.year;
    let month = start.month;
    while (daysInMonth(year, month) < anchor.day) {
      month -= 1;
      if (month === 0) {
        month = 12;
        year -= 1;
      }
    }
    return formatLocal({ ...start, day: anchor.day, month, year });
  }
  if (anchor.unit === "yearly" && anchor.month === 2 && anchor.day === 29 && !(start.month === 2 && start.day === 29)) {
    let year = start.year;
    while (daysInMonth(year, 2) < 29) year -= 1;
    return formatLocal({ ...start, day: 29, month: 2, year });
  }
  return startLocal;
}

/**
 * Delivery moment under quiet hours, mirroring `reminder-dispatch-repository.ts`: inside the window
 * the message waits for its end, on the next day when a window crossing midnight began that evening.
 */
export function shiftForQuietHours(local: string, quiet: QuietHours | null): { crossedMidnight: boolean; local: string } {
  if (quiet === null) return { crossedMidnight: false, local };
  const time = local.slice(11);
  const date = local.slice(0, 10);
  const atEnd = `${date}T${quiet.end}`;
  if (quiet.start < quiet.end) {
    return time >= quiet.start && time < quiet.end
      ? { crossedMidnight: false, local: atEnd }
      : { crossedMidnight: false, local };
  }
  if (time >= quiet.start) return { crossedMidnight: true, local: addLocalDays(atEnd, 1) };
  if (time < quiet.end) return { crossedMidnight: false, local: atEnd };
  return { crossedMidnight: false, local };
}
