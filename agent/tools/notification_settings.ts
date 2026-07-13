/**
 * Consolidated personal notification settings tool.
 *
 * Export:
 * - `notification_settings` reads or updates timezone and quiet-hour policy.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../lib/app-error.js";
import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import { reminderRepository } from "../lib/reminders/reminder-repository.js";

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).nullable();
const notificationSettingsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get") }).strict(),
  z.object({
    action: z.literal("set"),
    quietEnd: timeSchema,
    quietStart: timeSchema,
    timezone: z.string().min(1).max(100),
  }).strict(),
]);

export default defineTool({
  approval: ({ toolInput }) =>
    toolInput?.action === "set" ? "user-approval" : "not-applicable",
  description:
    "Получить или настроить личный часовой пояс IANA и тихие часы. Начало и конец тихих часов задаются вместе либо оба равны null.",
  inputSchema: notificationSettingsSchema,
  async execute(input, ctx) {
    const authorization = requireReminderAuthorization(ctx);
    if (authorization.telegramChatType !== "private") {
      throw new AppError(
        "AGENT_NOTIFICATION_SETTINGS_PRIVATE_ONLY",
        "Настройки уведомлений доступны только в личном чате",
      );
    }
    if (input.action === "get") {
      return await reminderRepository.getNotificationSettings(authorization);
    }

    const { action: _action, ...settings } = input;
    return await reminderRepository.configureNotifications(authorization, settings);
  },
});
