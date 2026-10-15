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
    "Постранично показать предстоящие и приостановленные личные и семейные напоминания текущего участника, ближайшие первыми.",
    "Отправленные здесь не показываются: ищи их в list_proactive_deliveries с sourceKind:\"reminder\".",
    "Результат: {items,nextCursor}; если nextCursor не null, передай его без изменений для следующей страницы.",
  ].join(" "),
  inputSchema: z.object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(REMINDER_LIST_MAX_LIMIT).default(REMINDER_LIST_DEFAULT_LIMIT),
  }).strict(),
  async execute(input, ctx) {
    return await reminderRepository.list(requireReminderAuthorization(ctx), input);
  },
});
