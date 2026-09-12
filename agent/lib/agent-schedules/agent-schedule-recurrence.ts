/**
 * Pure recurrence helpers for agent schedules.
 *
 * Exports:
 * - `weekdayFromDate`: ISO weekday for UTC dates used by validation and tests.
 * - `describeRecurrence`: concise Russian recurrence summary for tool results.
 * - `recurrenceValues`: shared persistence projection for both schedule creation boundaries.
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
  if (recurrence.kind !== "weekly") {
    const labels = {
      minutely: ["ежеминутно", "минут"], hourly: ["ежечасно", "часов"],
      daily: ["ежедневно", "дней"], monthly: ["ежемесячно", "месяцев"], yearly: ["ежегодно", "лет"],
    } as const;
    const [single, plural] = labels[recurrence.kind];
    return recurrence.interval === 1 ? single : `каждые ${recurrence.interval} ${plural}`;
  }
  const days = recurrence.daysOfWeek.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return recurrence.interval === 1
    ? `еженедельно: ${days}`
    : `каждые ${recurrence.interval} недель: ${days}`;
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
