/**
 * Consolidated reminder mutation tool.
 *
 * Export:
 * - `manage_reminder` routes create, update, pause, resume, and delete actions.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  REMINDER_CONTENT_MAX_LENGTH,
  REMINDER_RECURRENCE_INTERVAL_MAX,
} from "../lib/reminders/reminder-config.js";
import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import { reminderRepository } from "../lib/reminders/reminder-repository.js";

const reminderIdSchema = z.string().uuid();
const recurrenceSchema = z.object({
  interval: z.number().int().min(1).max(REMINDER_RECURRENCE_INTERVAL_MAX),
  unit: z.enum(["daily", "weekly", "monthly"]),
}).strict();

const manageReminderSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    content: z.string().min(1).max(REMINDER_CONTENT_MAX_LENGTH),
    firstRunAt: z.string().datetime({ offset: true }),
    recurrence: recurrenceSchema.nullable(),
    scope: z.enum(["personal", "family"]),
    timezone: z.string().min(1).max(100),
  }).strict(),
  z.object({
    action: z.literal("update"),
    content: z.string().min(1).max(REMINDER_CONTENT_MAX_LENGTH).optional(),
    firstRunAt: z.string().datetime({ offset: true }).optional(),
    id: reminderIdSchema,
    recurrence: recurrenceSchema.nullable().optional(),
  }).strict(),
  z.object({ action: z.literal("pause"), id: reminderIdSchema }).strict(),
  z.object({ action: z.literal("resume"), id: reminderIdSchema }).strict(),
  z.object({ action: z.literal("delete"), id: reminderIdSchema }).strict(),
]);

export default defineTool({
  approval: always(),
  description:
    "Создать, изменить, приостановить, возобновить или удалить напоминание. Существующую запись сначала найти через list_reminders.",
  inputSchema: manageReminderSchema,
  async execute(input, ctx) {
    const authorization = requireReminderAuthorization(ctx);
    if (input.action === "create") {
      const { action: _action, firstRunAt, ...values } = input;
      return await reminderRepository.create(authorization, {
        ...values,
        firstRunAt: new Date(firstRunAt),
        operationKey: ctx.callId,
      });
    }
    if (input.action === "update") {
      const { action: _action, firstRunAt, id, ...values } = input;
      return await reminderRepository.update(authorization, id, {
        ...values,
        ...(firstRunAt === undefined ? {} : { firstRunAt: new Date(firstRunAt) }),
        operationKey: ctx.callId,
      });
    }
    if (input.action === "pause" || input.action === "resume") {
      return await reminderRepository.update(authorization, input.id, {
        enabled: input.action === "resume",
        operationKey: ctx.callId,
      });
    }

    return {
      deleted: await reminderRepository.delete(authorization, input.id, ctx.callId),
    };
  },
});
