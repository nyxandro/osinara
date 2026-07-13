/**
 * Pure reminder input validation.
 *
 * Exports:
 * - `NotificationSettingsInput`: explicit timezone and optional quiet-hour pair.
 * - Date, content, recurrence, and quiet-hour validators used at repository boundaries.
 */
import { AppError } from "../app-error.js";
import {
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "./reminder-config.js";
import type { ReminderRecurrence } from "./reminder-record.js";

export interface NotificationSettingsInput {
  quietEnd: string | null;
  quietStart: string | null;
  timezone: string;
}

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
    !["daily", "weekly", "monthly"].includes(value.unit) ||
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

export function requireQuietHours(input: NotificationSettingsInput): void {
  const bothAbsent = input.quietStart === null && input.quietEnd === null;
  const bothValid =
    input.quietStart !== null &&
    input.quietEnd !== null &&
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
