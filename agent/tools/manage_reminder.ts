/**
 * Consolidated reminder mutation tool.
 *
 * Export:
 * - `manage_reminder`: routes create, update, pause, resume, and delete actions.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root JSON Schema unions in Eve descriptors.
 * - Action-specific validators return actionable Russian AppError messages.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "../lib/reminders/reminder-config.js";
import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import type { ReminderRecurrence, ReminderScope } from "../lib/reminders/reminder-record.js";
import { reminderRepository } from "../lib/reminders/reminder-repository.js";
import {
  optionalIsoDate,
  optionalString,
  requireAction,
  requiredEnum,
  requiredIsoDate,
  requiredString,
  requiredUuid,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_REMINDER_INPUT_INVALID";
const TOOL_ACTIONS = ["create", "update", "pause", "resume", "delete"] as const;
const RECURRENCE_UNITS = ["daily", "weekly", "monthly"] as const;
const SCOPES = ["personal", "family"] as const;
const TOP_LEVEL_FIELDS = [
  "action",
  "content",
  "firstRunAt",
  "id",
  "recurrence",
  "scope",
  "timezone",
] as const;

const recurrenceSchema = z.object({
  interval: z.number().optional(),
  unit: z.string().optional(),
}).passthrough();

const manageReminderSchema = z.object({
  action: z.string().optional(),
  content: z.string().optional(),
  firstRunAt: z.string().optional(),
  id: z.string().optional(),
  recurrence: z.union([recurrenceSchema, z.null()]).optional(),
  scope: z.string().optional(),
  timezone: z.string().optional(),
}).passthrough();

type ReminderAction = (typeof TOOL_ACTIONS)[number];

function requireReminderRecurrence(raw: unknown): ReminderRecurrence | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для recurrence передайте null или объект {\"unit\":\"weekly\",\"interval\":1}",
    );
  }
  const recurrence = raw as Record<string, unknown>;
  requireOnlyFields(recurrence, ["interval", "unit"], "recurrence", INPUT_ERROR_CODE);
  const unit = requiredEnum(recurrence, "unit", RECURRENCE_UNITS, INPUT_ERROR_CODE);
  const interval = recurrence.interval;
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > REMINDER_RECURRENCE_INTERVAL_MAX
  ) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для recurrence передайте null или объект {\"unit\":\"weekly\",\"interval\":1}",
    );
  }
  return { interval, unit };
}

function optionalReminderRecurrence(raw: unknown): ReminderRecurrence | null | undefined {
  return raw === undefined ? undefined : requireReminderRecurrence(raw);
}

function requireReminderId(input: Record<string, unknown>): string {
  return requiredUuid(input, "id", INPUT_ERROR_CODE, "напоминание из list_reminders");
}

function requireCreateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "content",
    "firstRunAt",
    "recurrence",
    "scope",
    "timezone",
  ], "action=create", INPUT_ERROR_CODE);
  return {
    content: requiredString(input, "content", INPUT_ERROR_CODE, "Позвонить врачу", {
      maxLength: REMINDER_CONTENT_MAX_LENGTH,
    }),
    firstRunAt: requiredIsoDate(input, "firstRunAt", INPUT_ERROR_CODE),
    recurrence: requireReminderRecurrence(input.recurrence),
    scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE) as ReminderScope,
    timezone: requiredString(input, "timezone", INPUT_ERROR_CODE, "Europe/Moscow", { maxLength: 100 }),
  };
}

function requireUpdateInput(input: Record<string, unknown>) {
  requireOnlyFields(input, [
    "action",
    "content",
    "firstRunAt",
    "id",
    "recurrence",
  ], "action=update", INPUT_ERROR_CODE);
  const content = optionalString(input, "content", INPUT_ERROR_CODE, "Позвонить врачу", {
    maxLength: REMINDER_CONTENT_MAX_LENGTH,
  });
  const firstRunAt = optionalIsoDate(input, "firstRunAt", INPUT_ERROR_CODE);
  const recurrence = optionalReminderRecurrence(input.recurrence);
  if (content === undefined && firstRunAt === undefined && recurrence === undefined) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=update передайте хотя бы одно изменение: content, firstRunAt или recurrence",
    );
  }
  return { content, firstRunAt, id: requireReminderId(input), recurrence };
}

function requireIdOnlyInput(input: Record<string, unknown>, action: ReminderAction): string {
  requireOnlyFields(input, ["action", "id"], `action=${action}`, INPUT_ERROR_CODE);
  return requireReminderId(input);
}

const TOOL_DESCRIPTION = [
  "Создать, изменить, приостановить, возобновить или удалить обычное напоминание с текстом уведомления.",
  "Это не агентное расписание: если нужен будущий автономный запуск агента с исследованием или отчётом, используй manage_agent_schedule.",
  "Create payload: {\"action\":\"create\",\"content\":\"Позвонить врачу\",\"firstRunAt\":\"2026-08-01T10:00:00+03:00\",\"timezone\":\"Europe/Moscow\",\"scope\":\"personal\",\"recurrence\":null}.",
  "Повторение: без повтора recurrence=null; повтор — {\"unit\":\"daily\",\"interval\":1}, {\"unit\":\"weekly\",\"interval\":1} или {\"unit\":\"monthly\",\"interval\":1}.",
  "firstRunAt всегда ISO datetime с UTC offset, timezone всегда IANA. Перед update/pause/resume/delete сначала найди id через list_reminders.",
].join(" ");

export default defineTool({
  approval: always(),
  description: TOOL_DESCRIPTION,
  inputSchema: manageReminderSchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "manage_reminder", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_reminder", INPUT_ERROR_CODE);
    const action = requireAction(payload, "manage_reminder", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const authorization = requireReminderAuthorization(ctx);
    if (action === "create") {
      const values = requireCreateInput(payload);
      return await reminderRepository.create(authorization, {
        ...values,
        operationKey: ctx.callId,
      });
    }
    if (action === "update") {
      const { id, ...values } = requireUpdateInput(payload);
      return await reminderRepository.update(authorization, id, {
        ...values,
        operationKey: ctx.callId,
      });
    }
    if (action === "pause" || action === "resume") {
      return await reminderRepository.update(authorization, requireIdOnlyInput(payload, action), {
        enabled: action === "resume",
        operationKey: ctx.callId,
      });
    }

    return {
      deleted: await reminderRepository.delete(authorization, requireIdOnlyInput(payload, action), ctx.callId),
    };
  },
});
