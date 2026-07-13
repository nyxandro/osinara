/**
 * Scoped task listing tool.
 *
 * Export:
 * - Eve `list_tasks` tool returning current-user personal and family tasks.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import { taskRepository } from "../lib/tasks/task-repository.js";

export default defineTool({
  description: "Показать доступные текущему участнику личные и семейные задачи.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return await taskRepository.list(requireReminderAuthorization(ctx));
  },
});
