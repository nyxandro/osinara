/**
 * Consolidated scheduled agent scenario mutation tool.
 *
 * Export:
 * - `manage_agent_schedule` routes create, update, pause, resume, run-now, and delete actions.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  AGENT_SCHEDULE_PROMPT_MAX_LENGTH,
  AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX,
  AGENT_SCHEDULE_TITLE_MAX_LENGTH,
  AGENT_SCHEDULE_USER_REQUEST_MAX_LENGTH,
} from "../lib/agent-schedules/agent-schedule-config.js";
import { requireAgentScheduleAuthorization } from "../lib/agent-schedules/agent-schedule-context.js";
import { agentScheduleRepository } from "../lib/agent-schedules/agent-schedule-repository.js";
import type { AgentScheduleInputRecurrence } from "../lib/agent-schedules/agent-schedule-validation.js";
import { AppError } from "../lib/app-error.js";

const TOOL_ACTIONS = ["create", "update", "pause", "resume", "run_now", "delete"] as const;
const RECURRENCE_KINDS = ["once", "daily", "weekly"] as const;
const SCOPES = ["personal", "family"] as const;
const ISO_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ToolAction = (typeof TOOL_ACTIONS)[number];
type ScheduleScope = (typeof SCOPES)[number];

const TOP_LEVEL_FIELDS = [
  "action",
  "firstRunAt",
  "id",
  "nextRunAt",
  "recurrence",
  "scenarioPrompt",
  "scope",
  "timezone",
  "title",
  "userRequest",
] as const;

const manageAgentScheduleSchema = z.object({
  action: z.string().optional(),
  firstRunAt: z.string().optional(),
  id: z.string().optional(),
  nextRunAt: z.string().optional(),
  recurrence: z.object({
    daysOfWeek: z.array(z.number()).optional(),
    interval: z.number().optional(),
    kind: z.string().optional(),
  }).passthrough().optional(),
  scenarioPrompt: z.string().optional(),
  scope: z.string().optional(),
  timezone: z.string().optional(),
  title: z.string().optional(),
  userRequest: z.string().optional(),
}).passthrough();

function inputError(message: string): never {
  throw new AppError("AGENT_SCHEDULE_INPUT_INVALID", message);
}

function requireOnlyFields(
  input: Record<string, unknown>,
  allowedFields: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedFields);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    inputError(
      `${label} содержит неизвестные поля: ${extra.join(", ")}. ` +
        `Используйте только: ${allowedFields.join(", ")}`,
    );
  }
}

function requiredString(input: Record<string, unknown>, key: string, example: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    inputError(`Поле ${key} обязательно и должно быть строкой. Пример: ${example}`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string, example: string): string | undefined {
  if (input[key] === undefined) return undefined;
  return requiredString(input, key, example);
}

function requireAction(input: Record<string, unknown>): ToolAction {
  const action = input.action;
  if (typeof action !== "string" || !TOOL_ACTIONS.includes(action as ToolAction)) {
    inputError(
      "Для manage_agent_schedule передайте action: " +
        `${TOOL_ACTIONS.join(" | ")}. Пример create: {"action":"create",...}`,
    );
  }
  return action as ToolAction;
}

function requiredUuid(input: Record<string, unknown>): string {
  const id = requiredString(
    input,
    "id",
    "00000000-0000-4000-8000-000000000001",
  );
  if (!UUID_PATTERN.test(id)) {
    inputError("Поле id должно быть UUID существующего агентного расписания из list_agent_schedules");
  }
  return id;
}

function requiredDate(input: Record<string, unknown>, key: string): Date {
  const value = requiredString(input, key, "2026-07-15T23:33:00+03:00");
  if (!ISO_OFFSET_PATTERN.test(value)) {
    inputError(`Поле ${key} должно быть ISO datetime с UTC offset, например 2026-07-15T23:33:00+03:00`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    inputError(`Поле ${key} содержит некорректную дату. Пример: 2026-07-15T23:33:00+03:00`);
  }
  return date;
}

function optionalDate(input: Record<string, unknown>, key: string): Date | undefined {
  if (input[key] === undefined) return undefined;
  return requiredDate(input, key);
}

function requiredScope(input: Record<string, unknown>): ScheduleScope {
  const scope = requiredString(input, "scope", "personal");
  if (!SCOPES.includes(scope as ScheduleScope)) {
    inputError("Поле scope должно быть personal или family");
  }
  return scope as ScheduleScope;
}

function recurrenceObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    inputError(
      "Поле recurrence должно быть объектом. Примеры: " +
        "{\"kind\":\"once\"}, {\"kind\":\"daily\",\"interval\":1}, " +
        "{\"kind\":\"weekly\",\"interval\":1,\"daysOfWeek\":[1,2,3,4,5]}",
    );
  }
  const recurrence = raw as Record<string, unknown>;
  requireOnlyFields(recurrence, ["daysOfWeek", "interval", "kind"], "recurrence");
  return recurrence;
}

function requiredInterval(raw: unknown, example: string): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > AGENT_SCHEDULE_RECURRENCE_INTERVAL_MAX
  ) {
    inputError(
      `Для ${example} recurrence передайте recurrence: ` +
        (example === "daily"
          ? "{\"kind\":\"daily\",\"interval\":1}"
          : "{\"kind\":\"weekly\",\"interval\":1,\"daysOfWeek\":[1,2,3,4,5]}"),
    );
  }
  return raw;
}

function requiredDaysOfWeek(raw: unknown): number[] {
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 7 ||
    raw.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7)
  ) {
    inputError(
      "Для weekly recurrence передайте daysOfWeek как ISO-дни недели 1-7, например [1,2,3,4,5] для будней",
    );
  }
  return raw;
}

function requiredRecurrence(raw: unknown): AgentScheduleInputRecurrence {
  const recurrence = recurrenceObject(raw);
  const kind = recurrence.kind;
  if (typeof kind !== "string" || !RECURRENCE_KINDS.includes(kind as never)) {
    inputError("Поле recurrence.kind должно быть once, daily или weekly");
  }
  if (kind === "once") {
    if (recurrence.interval !== undefined || recurrence.daysOfWeek !== undefined) {
      inputError("Для once recurrence передайте только recurrence: {\"kind\":\"once\"}");
    }
    return { kind: "once" };
  }
  if (kind === "daily") {
    if (recurrence.daysOfWeek !== undefined) {
      inputError("Для daily recurrence не передавайте daysOfWeek; используйте recurrence: {\"kind\":\"daily\",\"interval\":1}");
    }
    return { interval: requiredInterval(recurrence.interval, "daily"), kind: "daily" };
  }
  return {
    daysOfWeek: requiredDaysOfWeek(recurrence.daysOfWeek),
    interval: requiredInterval(recurrence.interval, "weekly"),
    kind: "weekly",
  };
}

function optionalRecurrence(raw: unknown): AgentScheduleInputRecurrence | undefined {
  return raw === undefined ? undefined : requiredRecurrence(raw);
}

function requireCreateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "firstRunAt",
    "recurrence",
    "scenarioPrompt",
    "scope",
    "timezone",
    "title",
    "userRequest",
  ], "action=create");
  return {
    firstRunAt: requiredDate(input, "firstRunAt"),
    recurrence: requiredRecurrence(input.recurrence),
    scenarioPrompt: requiredString(input, "scenarioPrompt", "Собери краткую сводку..."),
    scope: requiredScope(input),
    timezone: requiredString(input, "timezone", "Europe/Moscow"),
    title: requiredString(input, "title", "Дайджест: новые модели ИИ"),
    userRequest: requiredString(input, "userRequest", "ежедневно в 23:33 получать сводку"),
  };
}

function requireUpdateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "id",
    "nextRunAt",
    "recurrence",
    "scenarioPrompt",
    "title",
    "userRequest",
  ], "action=update");
  const nextRunAt = optionalDate(input, "nextRunAt");
  const recurrence = optionalRecurrence(input.recurrence);
  const scenarioPrompt = optionalString(input, "scenarioPrompt", "Собери краткую сводку...");
  const title = optionalString(input, "title", "Дайджест: новые модели ИИ");
  const userRequest = optionalString(input, "userRequest", "ежедневно в 23:33 получать сводку");
  if (
    nextRunAt === undefined &&
    recurrence === undefined &&
    scenarioPrompt === undefined &&
    title === undefined &&
    userRequest === undefined
  ) {
    inputError("Для action=update передайте хотя бы одно поле изменения: nextRunAt, recurrence, scenarioPrompt, title или userRequest");
  }
  return { id: requiredUuid(input), nextRunAt, recurrence, scenarioPrompt, title, userRequest };
}

const TOOL_DESCRIPTION = [
  "Создать, изменить, приостановить, возобновить, запустить сейчас или удалить агентное расписание.",
  "Это не напоминание: schedule запускает агента по сценарию и отправляет итог. Существующее расписание сначала найди через list_agent_schedules.",
  "Create payload: {\"action\":\"create\",\"title\":\"Дайджест: новые модели ИИ\",\"firstRunAt\":\"2026-07-15T23:33:00+03:00\",\"timezone\":\"Europe/Moscow\",\"recurrence\":{\"kind\":\"daily\",\"interval\":1},\"scope\":\"personal\",\"scenarioPrompt\":\"Что собрать, источники, фильтры, формат итогового сообщения и когда не присылать пустой отчет\",\"userRequest\":\"ежедневно в 23:33 МСК получать сводку\"}.",
  "Recurrence: once = {\"kind\":\"once\"}; daily = {\"kind\":\"daily\",\"interval\":1}; weekly = {\"kind\":\"weekly\",\"interval\":1,\"daysOfWeek\":[1,2,3,4,5]} где ISO 1=понедельник ... 7=воскресенье.",
  "firstRunAt и nextRunAt всегда ISO datetime с UTC offset. timezone всегда IANA, например Europe/Moscow. scope: personal только в личном чате, family только в зарегистрированной семейной группе.",
].join(" ");

export default defineTool({
  approval: always(),
  description: TOOL_DESCRIPTION,
  inputSchema: manageAgentScheduleSchema,
  async execute(input, ctx) {
    requireOnlyFields(input, TOP_LEVEL_FIELDS, "manage_agent_schedule");
    const action = requireAction(input);
    const authorization = requireAgentScheduleAuthorization(ctx);
    if (action === "create") {
      const values = requireCreateInput(input);
      return await agentScheduleRepository.create(authorization, {
        ...values,
        operationKey: ctx.callId,
      });
    }
    if (action === "update") {
      const { id, ...values } = requireUpdateInput(input);
      return await agentScheduleRepository.update(authorization, id, {
        ...values,
        operationKey: ctx.callId,
      });
    }
    if (action === "pause" || action === "resume") {
      requireOnlyFields(input, ["action", "id"], `action=${action}`);
      return await agentScheduleRepository.update(authorization, requiredUuid(input), {
        enabled: action === "resume",
        operationKey: ctx.callId,
      });
    }
    if (action === "run_now") {
      requireOnlyFields(input, ["action", "id"], "action=run_now");
      return await agentScheduleRepository.runNow(authorization, requiredUuid(input), ctx.callId);
    }

    requireOnlyFields(input, ["action", "id"], "action=delete");
    return {
      deleted: await agentScheduleRepository.delete(authorization, requiredUuid(input), ctx.callId),
    };
  },
});
