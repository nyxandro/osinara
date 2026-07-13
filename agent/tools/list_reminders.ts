/**
 * Reminder listing tool.
 *
 * Export:
 * - Eve `list_reminders` tool for current-user personal and family reminders.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import { reminderRepository } from "../lib/reminders/reminder-repository.js";

export default defineTool({
  description: "Показать доступные текущему участнику личные и семейные напоминания.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return await reminderRepository.list(requireReminderAuthorization(ctx));
  },
});
