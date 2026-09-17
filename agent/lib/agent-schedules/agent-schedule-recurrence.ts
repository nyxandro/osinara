/**
 * Pure recurrence helpers for agent schedules.
 *
 * Exports:
 * - `weekdayFromDate`: ISO weekday for UTC dates used by validation and tests.
 * - `recurrenceValues`: shared persistence projection for both schedule creation boundaries.
 */
import type { AgentScheduleRecurrence } from "./agent-schedule-record.js";

export function weekdayFromDate(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

export function recurrenceValues(recurrence: AgentScheduleRecurrence): {
  daysOfWeek: number[] | null;
  interval: number;
  kind: AgentScheduleRecurrence["kind"];
} {
  if (recurrence.kind === "once") return { daysOfWeek: null, interval: 1, kind: "once" };
  return {
    daysOfWeek: recurrence.kind === "weekly" ? recurrence.daysOfWeek : null,
    interval: recurrence.interval,
    kind: recurrence.kind,
  };
}
