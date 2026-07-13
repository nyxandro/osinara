/**
 * Family member lookup for task assignment.
 *
 * Export:
 * - Eve `list_family_members` tool returning current verified family members.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import { taskRepository } from "../lib/tasks/task-repository.js";

export default defineTool({
  description:
    "Показать текущих участников семьи и их stable userId перед назначением семейной задачи.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return await taskRepository.listMembers(requireReminderAuthorization(ctx));
  },
});
