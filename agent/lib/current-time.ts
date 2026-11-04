/**
 * Trusted current-time formatting.
 *
 * Exports:
 * - `CurrentTimeResult`: JSON-safe UTC and optional local civil-time snapshot.
 * - `formatCurrentTimeContext`: serializes the turn-start clock for inbound context.
 * - `resolveCurrentTime`: validates a timezone and formats one current-time snapshot.
 */
import { AppError } from "./app-error.js";

export interface CurrentTimeResult {
  capturedAtUtc: string;
  localDate: string | null;
  localTime: string | null;
  /** Only without a timezone: says the UTC date is not the person's own. */
  note?: string;
  timezone: string | null;
  timezoneSource: "explicit" | "not_configured" | "user_settings" | "group_config";
  /** Only without a timezone: the UTC calendar date, so the weekday is never counted by hand (#451). */
  utcDate?: string;
  utcOffset: string | null;
  utcWeekday?: string;
  weekday: string | null;
}

const UNKNOWN_TIMEZONE_NOTE =
  "The person's timezone is unknown: utcDate and utcWeekday are for UTC, and the local date may differ near midnight.";

const CURRENT_TIME_TIMEZONE_ERROR_CODE = "AGENT_CURRENT_TIME_TIMEZONE_INVALID";
const UTC_TIMEZONE = "UTC";
const VALID_TIMEZONES = new Set([UTC_TIMEZONE, ...Intl.supportedValuesOf("timeZone")]);
const LOCAL_TIME_FORMAT_OPTIONS = {
  calendar: "iso8601",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  numberingSystem: "latn",
  second: "2-digit",
  timeZoneName: "longOffset",
  weekday: "long",
  year: "numeric",
} as const;

function requireTimezone(timezone: string): string {
  if (!VALID_TIMEZONES.has(timezone)) {
    throw new AppError(
      CURRENT_TIME_TIMEZONE_ERROR_CODE,
      "Укажите корректный IANA timezone, например Europe/Moscow",
    );
  }
  return timezone;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((candidate) => candidate.type === type)?.value;
  if (!value) {
    throw new AppError(
      "AGENT_CURRENT_TIME_FORMAT_FAILED",
      `Не удалось определить компонент локального времени: ${type}`,
    );
  }
  return value;
}

function utcOffset(parts: Intl.DateTimeFormatPart[]): string {
  const value = part(parts, "timeZoneName");
  if (value === "GMT") return "+00:00";
  if (/^GMT[+-]\d{2}:\d{2}$/u.test(value)) return value.slice(3);
  throw new AppError(
    "AGENT_CURRENT_TIME_FORMAT_FAILED",
    "Не удалось определить смещение локального времени относительно UTC",
  );
}

export function formatCurrentTimeContext(currentTime: Date): string {
  return [
    "<current_time>",
    `captured_at_utc: ${currentTime.toISOString()}`,
    "precision: turn_start",
    "</current_time>",
  ].join("\n");
}

export function resolveCurrentTime(
  currentTime: Date,
  timezone: string | null,
  timezoneSource: CurrentTimeResult["timezoneSource"],
): CurrentTimeResult {
  // UTC remains useful without pretending that it is the user's local timezone. The model counted
  // the weekday from the bare UTC instant by hand and named Monday Sunday (#451), so the UTC date and
  // weekday are given ready, marked as UTC.
  if (timezone === null) {
    const utc = new Intl.DateTimeFormat("ru-RU", { ...LOCAL_TIME_FORMAT_OPTIONS, timeZone: UTC_TIMEZONE }).formatToParts(currentTime);
    return {
      capturedAtUtc: currentTime.toISOString(),
      localDate: null,
      localTime: null,
      note: UNKNOWN_TIMEZONE_NOTE,
      timezone: null,
      timezoneSource,
      utcDate: `${part(utc, "year")}-${part(utc, "month")}-${part(utc, "day")}`,
      utcOffset: null,
      utcWeekday: part(utc, "weekday"),
      weekday: null,
    };
  }

  // Format all civil-time fields from one instant so date-boundary answers stay coherent.
  const validatedTimezone = requireTimezone(timezone);
  const parts = new Intl.DateTimeFormat("ru-RU", {
    ...LOCAL_TIME_FORMAT_OPTIONS,
    timeZone: validatedTimezone,
  }).formatToParts(currentTime);
  return {
    capturedAtUtc: currentTime.toISOString(),
    localDate: `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`,
    localTime: `${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}`,
    timezone: validatedTimezone,
    timezoneSource,
    utcOffset: utcOffset(parts),
    weekday: part(parts, "weekday"),
  };
}
