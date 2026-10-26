/**
 * Validation of a monitor's settings when a schedule is created or changed.
 *
 * Exports:
 * - `resolveCreatedScheduleCheck`: the check and window of a new schedule, or `null` for a plain one.
 * - `resolveUpdatedScheduleCheck`: the check and window after an update, and whether the script changed.
 * - `requireMonitorWindowOpen`: a monitor whose window has closed cannot run again until moved.
 *
 * A monitor is a wake-up in the conversation: an isolated run has no conversation to wake, and the
 * database refuses one. Its check runs at most every few minutes because each keeps the chat's
 * sandbox container awake, and it watches for a bounded time.
 */
import { AppError } from "../app-error.js";
import {
  SCHEDULE_CHECK_COMMAND_MAX_LENGTH,
  SCHEDULE_CHECK_MAX_WINDOW_DAYS,
  SCHEDULE_CHECK_MIN_INTERVAL_MINUTES,
} from "./agent-schedule-check-contract.js";
import type { AgentScheduleExecutionContext, AgentScheduleRecurrence } from "./agent-schedule-record.js";

const DAY_MILLISECONDS = 24 * 60 * 60_000;

export interface ScheduleCheckSettings {
  checkCommand: string;
  checkUntil: Date;
}

function invalid(message: string): never {
  throw new AppError("AGENT_SCHEDULE_CHECK_INVALID", message);
}

function requireCommand(value: string): string {
  if (value.trim() === "" || value.length > SCHEDULE_CHECK_COMMAND_MAX_LENGTH) {
    invalid(
      `Поле checkCommand должно быть непустым Bash-скриптом не длиннее ${SCHEDULE_CHECK_COMMAND_MAX_LENGTH} символов. ` +
        "Длинную проверку положите в файл в рабочей папке и вызовите его",
    );
  }
  return value;
}

function requireRecurrence(recurrence: AgentScheduleRecurrence): void {
  if (recurrence.kind === "once" ||
    (recurrence.kind === "minutely" && recurrence.interval < SCHEDULE_CHECK_MIN_INTERVAL_MINUTES)) {
    invalid(
      `Монитор проверяет повторно и не чаще раза в ${SCHEDULE_CHECK_MIN_INTERVAL_MINUTES} минут. ` +
        "Укажите recurrence, например {\"kind\":\"minutely\",\"interval\":10}",
    );
  }
}

function requireWindow(checkUntil: Date, nextCheckAt: Date, now: Date): void {
  if (checkUntil.getTime() <= nextCheckAt.getTime() ||
    checkUntil.getTime() > now.getTime() + SCHEDULE_CHECK_MAX_WINDOW_DAYS * DAY_MILLISECONDS) {
    invalid(
      `Поле checkUntil должно быть позже ближайшей проверки и не дальше ${SCHEDULE_CHECK_MAX_WINDOW_DAYS} дней ` +
        "от текущего момента. Укажите срок, до которого действительно стоит следить",
    );
  }
}

function requireConversation(executionContext: AgentScheduleExecutionContext): void {
  if (executionContext !== "conversation") {
    invalid("Монитор бывает только у пробуждения в разговоре: передайте executionContext conversation");
  }
}

export function resolveCreatedScheduleCheck(
  input: {
    checkCommand?: string;
    checkUntil?: Date;
    executionContext: AgentScheduleExecutionContext;
    firstRunAt: Date;
    recurrence: AgentScheduleRecurrence;
  },
  now: Date,
): ScheduleCheckSettings | null {
  if (input.checkCommand === undefined && input.checkUntil === undefined) return null;
  if (input.checkCommand === undefined || input.checkUntil === undefined) {
    invalid("Монитор задаётся двумя полями сразу: checkCommand и checkUntil");
  }
  requireConversation(input.executionContext);
  const checkCommand = requireCommand(input.checkCommand);
  requireRecurrence(input.recurrence);
  requireWindow(input.checkUntil, input.firstRunAt, now);
  return { checkCommand, checkUntil: input.checkUntil };
}

export function resolveUpdatedScheduleCheck(
  schedule: {
    checkCommand: string | null;
    checkUntil: Date | null;
    executionContext: AgentScheduleExecutionContext;
    nextRunAt: Date;
  },
  input: { checkCommand?: string; checkUntil?: Date; nextRunAt?: Date },
  recurrence: AgentScheduleRecurrence,
  now: Date,
): { checkCommand: string | null; checkUntil: Date | null; commandChanged: boolean } {
  const checkCommand = input.checkCommand ?? schedule.checkCommand;
  const checkUntil = input.checkUntil ?? schedule.checkUntil;
  if (checkCommand === null && checkUntil === null) return { checkCommand: null, checkUntil: null, commandChanged: false };
  if (checkCommand === null || checkUntil === null) {
    invalid("Монитор задаётся двумя полями сразу: checkCommand и checkUntil");
  }
  requireConversation(schedule.executionContext);
  requireCommand(checkCommand);
  requireRecurrence(recurrence);
  const nextCheckAt = input.nextRunAt ?? schedule.nextRunAt;
  if (input.checkUntil !== undefined) requireWindow(checkUntil, nextCheckAt, now);
  else if (nextCheckAt.getTime() > checkUntil.getTime()) {
    invalid("Поле nextRunAt монитора не может быть позже checkUntil. Продлите checkUntil или выберите время раньше");
  }
  return { checkCommand, checkUntil, commandChanged: checkCommand !== schedule.checkCommand };
}

export function requireMonitorWindowOpen(checkUntil: Date | null, now: Date): void {
  if (checkUntil !== null && checkUntil.getTime() <= now.getTime()) {
    throw new AppError(
      "AGENT_SCHEDULE_CHECK_WINDOW_CLOSED",
      "Срок слежения монитора истёк. Продлите его через update с новым checkUntil",
    );
  }
}
