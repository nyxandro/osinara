/**
 * Reminder listing tool.
 *
 * Export:
 * - `list_reminders` tool for upcoming personal and family reminders of the current user.
 *
 * Reminders that wait for the person's timezone (#451) come with the first page as a short separate
 * list: there are few of them, and they have no moment to sort by until the zone is known.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import {
  REMINDER_LIST_DEFAULT_LIMIT,
  REMINDER_LIST_MAX_LIMIT,
} from "../reminders/reminder-config.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { timezoneWaitRepository } from "../reminders/reminder-timezone-wait-repository.js";

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: [
    "List the current participant's upcoming and paused personal and family reminders page by page, nearest first.",
    "Delivered ones are not shown here: look for them in list_proactive_deliveries with sourceKind:\"reminder\".",
    "Result: {items,nextCursor,awaiting}; if nextCursor is not null, pass it unchanged for the next page.",
    "awaiting, on the first page only, lists reminders that wait for the person's timezone: they are not set yet and become reminders once notification_settings saves the zone; change or delete them through manage_reminder by id.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT).default(REMINDER_LIST_DEFAULT_LIMIT),
  }).strict(),
  async execute(input, ctx) {
    const authorization = requireReminderAuthorization(ctx);
    const page = await reminderRepository.list(authorization, input);
    return { ...page, awaiting: input.cursor === undefined ? await timezoneWaitRepository.list(authorization) : [] };
  },
});
