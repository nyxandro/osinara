/**
 * Pure recurrence helpers for agent schedules.
 *
 * Exports:
 * - `weekdayFromDate`: ISO weekday for UTC dates used by validation and tests.
 * - `describeRecurrence`: concise Russian recurrence summary for tool results.
 */
import type { AgentScheduleRecurrence } from "./agent-schedule-record.js";

const WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  1: "пн",
  2: "вт",
  3: "ср",
  4: "чт",
  5: "пт",
  6: "сб",
  7: "вс",
};

export function weekdayFromDate(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

export function describeRecurrence(recurrence: AgentScheduleRecurrence): string {
  if (recurrence.kind === "once") return "один раз";
  if (recurrence.kind === "daily") {
    return recurrence.interval === 1 ? "ежедневно" : `каждые ${recurrence.interval} дней`;
  }
  const days = recurrence.daysOfWeek.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return recurrence.interval === 1
    ? `еженедельно: ${days}`
    : `каждые ${recurrence.interval} недель: ${days}`;
}
