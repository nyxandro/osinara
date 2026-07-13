/**
 * Consolidated personal and family task mutation tool.
 *
 * Export:
 * - `manage_task` routes explicit create, update, complete, and delete actions.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import { taskManagementRepository } from "../lib/tasks/task-management-repository.js";
import { taskRepository } from "../lib/tasks/task-repository.js";

const taskIdSchema = z.string().uuid();
const nullableScheduleFields = {
  details: z.string().min(1).max(2_000).nullable(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  timezone: z.string().min(1).max(100).nullable(),
} as const;

const manageTaskSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    assigneeUserId: z.string().uuid(),
    ...nullableScheduleFields,
    scope: z.enum(["personal", "family"]),
    title: z.string().min(1).max(300),
  }).strict(),
  z.object({
    action: z.literal("update"),
    assigneeUserId: z.string().uuid().optional(),
    ...nullableScheduleFields,
    id: taskIdSchema,
    title: z.string().min(1).max(300),
  }).strict(),
  z.object({ action: z.literal("complete"), id: taskIdSchema }).strict(),
  z.object({ action: z.literal("delete"), id: taskIdSchema }).strict(),
]);

export default defineTool({
  approval: always(),
  description:
    "Создать, изменить, завершить или удалить личную либо семейную задачу. Перед изменением существующей задачи получить её ID через list_tasks.",
  inputSchema: manageTaskSchema,
  async execute(input, ctx) {
    const authorization = requireReminderAuthorization(ctx);
    if (input.action === "create") {
      const { action: _action, dueAt, ...values } = input;
      return await taskRepository.create(authorization, {
        ...values,
        dueAt: dueAt === null ? null : new Date(dueAt),
        operationKey: ctx.callId,
      });
    }
    if (input.action === "update") {
      const { action: _action, dueAt, id, ...values } = input;
      return await taskManagementRepository.update(authorization, id, {
        ...values,
        dueAt: dueAt === null ? null : new Date(dueAt),
        operationKey: ctx.callId,
      });
    }
    if (input.action === "complete") {
      return await taskRepository.complete(authorization, input.id, ctx.callId);
    }

    return {
      deleted: await taskManagementRepository.delete(authorization, input.id, ctx.callId),
    };
  },
});
