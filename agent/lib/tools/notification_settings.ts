/**
 * Consolidated personal notification settings tool.
 *
 * Export:
 * - `notification_settings`: reads or updates timezone and quiet-hour policy.
 *
 * Key constructs:
 * - Object-shaped model schema publishes a required finite action discriminator.
 * - A semantic parser validates execution inputs.
 * - Input validation explains the exact quiet-hours contract before repository calls.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { withCallExamples, type CallExamples } from "../tool-call-examples.js";
import {
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID";
const TOOL_ACTIONS = ["get", "set"] as const;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const TOP_LEVEL_FIELDS = ["action", "quietEnd", "quietStart", "timezone"] as const;

const nullableTimeSchema = z.union([z.string(), z.null()]).optional();
const notificationSettingsSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Required action: get or set."),
  quietEnd: nullableTimeSchema.describe("Required for action=set: HH:MM or null."),
  quietStart: nullableTimeSchema.describe("Required for action=set: HH:MM or null."),
  timezone: z.string().optional().describe("A required IANA timezone, only for action=set."),
}).strict();

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

function requireNotificationSettingsInput(input: unknown) {
  const payload = requireInputRecord(input, "notification_settings", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "notification_settings", INPUT_ERROR_CODE);
  const action = requireAction(payload, "notification_settings", TOOL_ACTIONS, INPUT_ERROR_CODE);

  // MiniMax may materialize known set-only siblings for get. The read action ignores them and
  // cannot turn those values into a write; unpublished fields still fail in the global guard.
  if (action === "get") return { action } as const;
  return { action, values: requireSetInput(payload) } as const;
}

const TOOL_DESCRIPTION = [
  "Get or set the personal IANA timezone and quiet hours for reminders; save values the person explicitly named.",
  "Get: {\"action\":\"get\"}. Set: {\"action\":\"set\",\"timezone\":\"Europe/Moscow\",\"quietStart\":\"22:00\",\"quietEnd\":\"08:00\"} with an explicit IANA timezone and two different HH:MM values; quietStart=null and quietEnd=null turn quiet hours off.",
  "Never guess the timezone or quiet hours: ask the person.",
].join(" ");

export const NOTIFICATION_SETTINGS_CALL_EXAMPLES: CallExamples = {
  get: { action: "get" },
  set: { action: "set", timezone: "Europe/Moscow", quietStart: "22:00", quietEnd: "08:00" },
};

export default withCallExamples(defineTool({
  description: TOOL_DESCRIPTION,
  inputSchema: notificationSettingsSchema,
  async execute(input, ctx) {
    const parsed = requireNotificationSettingsInput(input);
    const authorization = requireReminderAuthorization(ctx);
    if (authorization.telegramChatType !== "private") {
      throw new AppError(
        "AGENT_NOTIFICATION_SETTINGS_PRIVATE_ONLY",
        "Настройки уведомлений доступны только в личном чате",
      );
    }
    if (parsed.action === "get") {
      return await reminderRepository.getNotificationSettings(authorization);
    }

    return await reminderRepository.configureNotifications(authorization, parsed.values);
  },
}), NOTIFICATION_SETTINGS_CALL_EXAMPLES);
