/**
 * Pure reminder input validation.
 *
 * Exports:
 * - `NotificationSettingsInput`: a timezone with where it came from, and an optional quiet-hour pair.
 * - Date, content, recurrence, and quiet-hour validators used at repository boundaries.
 */
import { AppError } from "../app-error.js";
import {
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "./reminder-config.js";
import { REMINDER_RECURRENCE_UNITS, type ReminderRecurrence } from "./reminder-record.js";

export interface NotificationSettingsInput {
  /** What the agent read the zone from, «город Тула из разговора»; required exactly when it guessed. */
  basis: string | null;
  /** Absent keeps the quiet hours already set; null turns them off. Given or absent together. */
  quietEnd?: string | null;
  quietStart?: string | null;
  /** `person`: the person named or confirmed it; `agent`: read from a clear sign (#451). */
  source: "agent" | "person";
  timezone: string;
}

export const TIMEZONE_BASIS_MAX_LENGTH = 200;

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function requireReminderDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError("AGENT_REMINDER_TIME_INVALID", "Укажите точное время напоминания");
  }
  return value;
}

export function requireReminderContent(value: string): string {
  const content = value.trim();
  if (!content || content.length > REMINDER_CONTENT_MAX_LENGTH) {
    throw new AppError(
      "AGENT_REMINDER_CONTENT_INVALID",
      `Текст напоминания должен содержать от 1 до ${REMINDER_CONTENT_MAX_LENGTH} символов`,
    );
  }
  return content;
}

export function requireReminderRecurrence(
  value: ReminderRecurrence | null,
): ReminderRecurrence | null {
  if (value === null) return null;
  if (
    !REMINDER_RECURRENCE_UNITS.includes(value.unit) ||
    !Number.isInteger(value.interval) ||
    value.interval < 1 ||
    value.interval > REMINDER_RECURRENCE_INTERVAL_MAX
  ) {
    throw new AppError(
      "AGENT_REMINDER_RECURRENCE_INVALID",
      "Период повторения напоминания имеет некорректный формат",
    );
  }
  return value;
}

export function requireNotificationSettings(input: NotificationSettingsInput): void {
  if (input.source === "agent" && (!input.basis?.trim() || input.basis.length > TIMEZONE_BASIS_MAX_LENGTH)) {
    throw new AppError(
      "AGENT_NOTIFICATION_TIMEZONE_BASIS_REQUIRED",
      `Укажите основание часового пояса до ${TIMEZONE_BASIS_MAX_LENGTH} символов, например «город Тула из разговора»`,
    );
  }
  if (input.quietStart === undefined && input.quietEnd === undefined) return;
  const bothAbsent = input.quietStart === null && input.quietEnd === null;
  const bothValid =
    typeof input.quietStart === "string" &&
    typeof input.quietEnd === "string" &&
    TIME_PATTERN.test(input.quietStart) &&
    TIME_PATTERN.test(input.quietEnd) &&
    input.quietStart !== input.quietEnd;
  if (!bothAbsent && !bothValid) {
    throw new AppError(
      "AGENT_QUIET_HOURS_INVALID",
      "Укажите разные начало и конец тихих часов в формате ЧЧ:ММ либо отключите оба значения",
    );
  }
}
