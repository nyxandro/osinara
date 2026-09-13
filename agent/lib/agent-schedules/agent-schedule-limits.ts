/** Shared validation and state guards for delivery limits and deferred pause. */
import { z } from "zod";
import { AppError } from "../app-error.js";
import type { AgentScheduleUpdateInput } from "./agent-schedule-repository.js";
import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";

// PostgreSQL integer storage boundary; no application-specific quota is imposed.
export const AGENT_SCHEDULE_MAX_RUNS = 2_147_483_647;
export const agentScheduleMaxRunsSchema = z.number().int().min(1).max(AGENT_SCHEDULE_MAX_RUNS).nullable();

export function requireAgentScheduleMaxRuns(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = agentScheduleMaxRunsSchema.safeParse(value);
  if (!parsed.success) throw new AppError("AGENT_SCHEDULE_LIMIT_INVALID",
    `Количество выполнений должно быть целым числом от 1 до ${AGENT_SCHEDULE_MAX_RUNS}; null снимает ограничение`);
  return parsed.data;
}

export function requireScheduleLimitConsistency(maxRuns: number | null, completedRuns: number, kind: AgentScheduleRecurrenceKind): void {
  if (maxRuns !== null && (maxRuns < completedRuns || (kind === "once" && maxRuns !== 1))) {
    throw new AppError("AGENT_SCHEDULE_LIMIT_INVALID",
      "Лимит не может быть меньше уже выполненного количества; для однократного расписания допустимо только одно выполнение");
  }
}

export function requireScheduleLimitRemaining(maxRuns: number | null, completedRuns: number): void {
  if (maxRuns !== null && completedRuns >= maxRuns) throw new AppError("AGENT_SCHEDULE_LIMIT_REACHED",
    "Расписание уже выполнило заданное количество раз. Увеличьте или снимите лимит перед возобновлением");
}

export function isPauseOnlyUpdate(input: AgentScheduleUpdateInput): boolean {
  return input.enabled === false && Object.entries(input).every(([key, value]) =>
    value === undefined || ["enabled", "operationKey", "requiredScope"].includes(key));
}

export const AGENT_SCHEDULE_LIMIT_DESCRIPTION =
  "Для N выполнений передай maxRuns:N в create/update: это общий лимит успешных запусков с подтверждённой доставкой, включая completedRuns. " +
  "Например, 10 раз раз в минуту: recurrence:{kind:'minutely',interval:1}, maxRuns:10. " +
  "Без maxRuns повтор не ограничен; maxRuns:null снимает лимит. Лимит не сбрасывается паузой, resume или run_now. " +
  "После достижения лимита расписание завершится автоматически без дополнительного запуска; не создавай файл-счётчик. " +
  "Pause во время запуска возвращает pauseRequested:true: текущий запуск и его ответ завершаются, следующие отключены. " +
  "Для остановки по условию используй pause, если управление расписанием разрешено в текущем чате.";
