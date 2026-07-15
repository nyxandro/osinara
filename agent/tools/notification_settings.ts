/**
 * Consolidated personal notification settings tool.
 *
 * Export:
 * - `notification_settings`: reads or updates timezone and quiet-hour policy.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root discriminated unions in tool descriptors.
 * - Input validation explains the exact quiet-hours contract before repository calls.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../lib/app-error.js";
import { requireReminderAuthorization } from "../lib/reminders/reminder-context.js";
import { reminderRepository } from "../lib/reminders/reminder-repository.js";
import {
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID";
const TOOL_ACTIONS = ["get", "set"] as const;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const TOP_LEVEL_FIELDS = ["action", "quietEnd", "quietStart", "timezone"] as const;

const nullableTimeSchema = z.union([z.string(), z.null()]).optional();
const notificationSettingsSchema = z.object({
  action: z.string().optional(),
  quietEnd: nullableTimeSchema,
  quietStart: nullableTimeSchema,
  timezone: z.string().optional(),
}).passthrough();

function requiredNullableTime(input: Record<string, unknown>, key: "quietEnd" | "quietStart"): string | null {
  const value = input[key];
  if (value === null) return null;
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Поле ${key} должно быть null или временем в формате ЧЧ:ММ, например 22:00`,
    );
  }
  return value;
}

function requireSetInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "quietEnd", "quietStart", "timezone"], "action=set", INPUT_ERROR_CODE);
  const quietStart = requiredNullableTime(input, "quietStart");
  const quietEnd = requiredNullableTime(input, "quietEnd");
  const bothDisabled = quietStart === null && quietEnd === null;
  const bothConfigured = quietStart !== null && quietEnd !== null && quietStart !== quietEnd;
  if (!bothDisabled && !bothConfigured) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Передайте quietStart и quietEnd вместе разными значениями ЧЧ:ММ либо оба null, чтобы отключить тихие часы",
    );
  }
  return {
    quietEnd,
    quietStart,
    timezone: requiredString(input, "timezone", INPUT_ERROR_CODE, "Europe/Moscow", { maxLength: 100 }),
  };
}

const TOOL_DESCRIPTION = [
  "Получить или настроить личный IANA timezone и тихие часы для напоминаний.",
  "Get payload: {\"action\":\"get\"}. Set payload: {\"action\":\"set\",\"timezone\":\"Europe/Moscow\",\"quietStart\":\"22:00\",\"quietEnd\":\"08:00\"}.",
  "Чтобы отключить тихие часы, передай quietStart=null и quietEnd=null. Не угадывай timezone или тихие часы; если данных нет, спроси пользователя.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) =>
    toolInput?.action === "set" ? "user-approval" : "not-applicable",
  description: TOOL_DESCRIPTION,
  inputSchema: notificationSettingsSchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "notification_settings", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "notification_settings", INPUT_ERROR_CODE);
    const action = requireAction(payload, "notification_settings", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const authorization = requireReminderAuthorization(ctx);
    if (authorization.telegramChatType !== "private") {
      throw new AppError(
        "AGENT_NOTIFICATION_SETTINGS_PRIVATE_ONLY",
        "Настройки уведомлений доступны только в личном чате",
      );
    }
    if (action === "get") {
      requireOnlyFields(payload, ["action"], "action=get", INPUT_ERROR_CODE);
      return await reminderRepository.getNotificationSettings(authorization);
    }

    return await reminderRepository.configureNotifications(authorization, requireSetInput(payload));
  },
});
