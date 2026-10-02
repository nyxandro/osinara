/**
 * Trusted current-time tool.
 *
 * Export:
 * - Eve `get_current_time` tool for a fresh UTC and optional local civil-time snapshot.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { resolveCurrentTime } from "../current-time.js";
import { currentTimeRepository } from "../current-time-repository.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { GROUP_REMINDER_TIMEZONE } from "../reminders/reminder-config.js";

const TOOL_DESCRIPTION = [
  "Получить точные текущие дату и время из системных часов.",
  "Без timezone использует настроенный IANA timezone текущего пользователя; если он не настроен, возвращает только UTC.",
  "Во внешней группе без timezone использует общий часовой пояс группы, не личные настройки участника.",
  "Для времени в другом часовом поясе передай timezone, например {\"timezone\":\"Asia/Tokyo\"}.",
  "Используй для уточнения текущего времени, даты, дня недели, timezone или после долгой операции; не угадывай эти значения.",
].join(" ");

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: TOOL_DESCRIPTION,
  inputSchema: z.object({ timezone: z.string().min(1).max(100).optional() }).strict(),
  async execute(input, ctx) {
    // Explicit timezone questions do not require or expose persisted user settings.
    if (input.timezone !== undefined) {
      return resolveCurrentTime(new Date(), input.timezone, "explicit");
    }

    if (ctx.session.auth.current?.attributes.groupType === "external") {
      return resolveCurrentTime(new Date(), GROUP_REMINDER_TIMEZONE, "group_config");
    }

    // The persisted timezone is scoped to the verified current family identity.
    const authorization = requireReminderAuthorization(ctx);
    const timezone = await currentTimeRepository.findUserTimezone(
      authorization.userId,
      authorization.familyId,
    );
    return resolveCurrentTime(
      new Date(),
      timezone,
      timezone === null ? "not_configured" : "user_settings",
    );
  },
});
