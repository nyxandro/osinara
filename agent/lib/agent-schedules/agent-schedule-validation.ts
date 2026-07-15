/**
 * Agent schedule input validation and recurrence normalization.
 *
 * Exports:
 * - `AgentScheduleInputRecurrence`: supported one-time, daily, and weekly recurrence.
 * - Required-field validators for titles, prompts, dates, recurrence, and Telegram topic IDs.
 */
import { AppError } from "../app-error.js";
import {
  AGENT_SCHEDULE_PROMPT_MAX_LENGTH,
  AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX,
  AGENT_SCHEDULE_TITLE_MAX_LENGTH,
  AGENT_SCHEDULE_USER_REQUEST_MAX_LENGTH,
  AGENT_SCHEDULE_WEEKDAYS,
} from "./agent-schedule-config.js";
import type { AgentScheduleRecurrence } from "./agent-schedule-record.js";

export type AgentScheduleInputRecurrence = AgentScheduleRecurrence;

const VALID_WEEKDAY_SET = new Set<number>(AGENT_SCHEDULE_WEEKDAYS);

function trimmedText(value: string, maxLength: number, code: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new AppError(code, `${label} должен быть непустым и не длиннее ${maxLength} символов`);
  }
  return trimmed;
}

export function requireAgentScheduleTitle(value: string): string {
  return trimmedText(
    value,
    AGENT_SCHEDULE_TITLE_MAX_LENGTH,
    "AGENT_SCHEDULE_TITLE_INVALID",
    "Название расписания",
  );
}

export function requireAgentScheduleUserRequest(value: string): string {
  return trimmedText(
    value,
    AGENT_SCHEDULE_USER_REQUEST_MAX_LENGTH,
    "AGENT_SCHEDULE_USER_REQUEST_INVALID",
    "Исходная просьба",
  );
}

export function requireAgentSchedulePrompt(value: string): string {
  return trimmedText(
    value,
    AGENT_SCHEDULE_PROMPT_MAX_LENGTH,
    "AGENT_SCHEDULE_PROMPT_INVALID",
    "Сценарий запуска",
  );
}

export function requireAgentScheduleDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError(
      "AGENT_SCHEDULE_TIME_INVALID",
      "Не удалось распознать время запуска агентного расписания",
    );
  }
  return value;
}

function requireInterval(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX
  ) {
    throw new AppError(
      "AGENT_SCHEDULE_RECURRENCE_INVALID",
      `Интервал повтора должен быть от 1 до ${AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX}`,
    );
  }
  return value;
}

export function requireAgentScheduleRecurrence(
  recurrence: AgentScheduleInputRecurrence,
): AgentScheduleRecurrence {
  if (recurrence.kind === "once") return { kind: "once" };
  if (recurrence.kind === "daily") {
    return { interval: requireInterval(recurrence.interval), kind: "daily" };
  }
  if (recurrence.kind !== "weekly") {
    throw new AppError(
      "AGENT_SCHEDULE_RECURRENCE_INVALID",
      "Поддерживаются только one-time, daily и weekly расписания",
    );
  }

  // Sort and deduplicate weekdays so the persisted contract is stable for replay checks.
  const days = [...new Set(recurrence.daysOfWeek)].sort((left, right) => left - right);
  if (days.length === 0 || days.some((day) => !VALID_WEEKDAY_SET.has(day))) {
    throw new AppError(
      "AGENT_SCHEDULE_RECURRENCE_INVALID",
      "Дни недели должны быть числами ISO от 1 (понедельник) до 7 (воскресенье)",
    );
  }
  return { daysOfWeek: days, interval: requireInterval(recurrence.interval), kind: "weekly" };
}

export function numericMessageThreadId(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(
      "AGENT_SCHEDULE_THREAD_INVALID",
      "Telegram передал некорректный идентификатор темы для расписания",
    );
  }
  return parsed;
}
