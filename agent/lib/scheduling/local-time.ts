/** Display a scheduled instant in its explicit IANA timezone without guessing the user's clock. */
import { AppError } from "../app-error.js";

export function localScheduledTime(instant: string, timezone: string): string {
  const date = new Date(instant);
  if (!timezone || Number.isNaN(date.getTime())) {
    throw new AppError("AGENT_SCHEDULE_TIME_INVALID", "Для расписания нужны корректные дата и часовой пояс");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
  } catch (cause) {
    const error = new AppError("AGENT_SCHEDULE_TIMEZONE_INVALID", "Часовой пояс расписания не распознан. Проверьте настройки расписания");
    error.cause = cause;
    throw error;
  }
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second} ${timezone}`;
}
