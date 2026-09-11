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
import { z } from "zod";

import {
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "../reminders/reminder-config.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import type { ReminderRecurrence } from "../reminders/reminder-record.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
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
} from "../tool-input-validation.js";

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
  interval: z.number().int().min(1).max(REMINDER_RECURRENCE_INTERVAL_MAX),
  unit: z.enum(RECURRENCE_UNITS),
}).strict();

const manageReminderSchema = z.object({
  action: z.enum(TOOL_ACTIONS),
  content: z.string().optional(),
  firstRunAt: z.string().optional(),
  id: z.string().optional(),
  recurrence: z.union([recurrenceSchema, z.null()]).optional(),
  scope: z.string().optional(),
  timezone: z.string().optional(),
}).strict();

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
    scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE) as (typeof SCOPES)[number],
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
    // MiniMax materializes these known create-only siblings; update ignores them explicitly.
    "scope",
    "timezone",
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

function requireManageReminderInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_reminder", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_reminder", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_reminder", TOOL_ACTIONS, INPUT_ERROR_CODE);

  if (action === "create") return { action, values: requireCreateInput(payload) } as const;
  if (action === "update") return { action, values: requireUpdateInput(payload) } as const;
  return { action, id: requireIdOnlyInput(payload, action) } as const;
}

const TOOL_DESCRIPTION = [
  "Создать, изменить, приостановить, возобновить или удалить обычное напоминание с текстом уведомления.",
  "Явной просьбы пользователя достаточно: выполняй без дополнительного подтверждения. Уточняй только недостающие или неоднозначные данные.",
  "content отправляется как готовый текст без вызова модели. Не сохраняй в нём задание что-то придумать или выполнить позже; если просят сочинить сообщение, подготовь его до создания напоминания.",
  "Это не агентное расписание: если нужен будущий автономный запуск агента с исследованием или отчётом, используй manage_agent_schedule.",
  "Create payload: {\"action\":\"create\",\"content\":\"Позвонить врачу\",\"firstRunAt\":\"2026-08-01T10:00:00+03:00\",\"timezone\":\"Europe/Moscow\",\"scope\":\"personal\",\"recurrence\":null}.",
  "Повторение: без повтора recurrence=null; повтор — {\"unit\":\"daily\",\"interval\":1}, {\"unit\":\"weekly\",\"interval\":1} или {\"unit\":\"monthly\",\"interval\":1}.",
  "Убрать повторение: {\"action\":\"update\",\"id\":\"<id из list_reminders>\",\"recurrence\":null}. Не удаляй и не пересоздавай напоминание для смены повторения.",
  "Update передаёт id и только изменяемые content, firstRunAt или recurrence. Pause/resume/delete передают только action и id.",
  "firstRunAt всегда ISO datetime с UTC offset, timezone всегда IANA. Перед update/pause/resume/delete сначала найди id через list_reminders.",
].join(" ");

export default defineTool({
  description: TOOL_DESCRIPTION,
  inputSchema: manageReminderSchema,
  async execute(input, ctx) {
    const parsed = requireManageReminderInput(input);
    const authorization = requireReminderAuthorization(ctx);
    if (parsed.action === "create") {
      return await reminderRepository.create(authorization, {
        ...parsed.values,
        operationKey: ctx.callId,
      });
    }
    if (parsed.action === "update") {
      const { id, ...values } = parsed.values;
      return await reminderRepository.update(authorization, id, {
        ...values,
        operationKey: ctx.callId,
      });
    }
    if (parsed.action === "pause" || parsed.action === "resume") {
      return await reminderRepository.update(authorization, parsed.id, {
        enabled: parsed.action === "resume",
        operationKey: ctx.callId,
      });
    }

    return {
      deleted: await reminderRepository.delete(authorization, parsed.id, ctx.callId),
    };
  },
});
