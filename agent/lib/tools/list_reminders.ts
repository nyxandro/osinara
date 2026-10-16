/**
 * Reminder listing tool.
 *
 * Export:
 * - `list_reminders` tool for upcoming personal and family reminders of the current user.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import {
  REMINDER_LIST_DEFAULT_LIMIT,
  REMINDER_LIST_MAX_LIMIT,
} from "../reminders/reminder-config.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "List the current participant's upcoming and paused personal and family reminders page by page, nearest first.",
    "Delivered ones are not shown here: look for them in list_proactive_deliveries with sourceKind:\"reminder\".",
    "Result: {items,nextCursor}; if nextCursor is not null, pass it unchanged for the next page.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT).default(REMINDER_LIST_DEFAULT_LIMIT),
  }).strict(),
  async execute(input, ctx) {
    return await reminderRepository.list(requireReminderAuthorization(ctx), input);
  },
});
