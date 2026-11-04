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
 * - A timezone says where it came from (#451): the person's words, or the agent's reading of a clear
 *   sign with its basis. The agent's reading is accepted only where no zone exists yet.
 * - Saving the zone sets the person's waiting reminders in the same step; the result says which were
 *   set, which time has passed and which reminders a correction moved, for the agent to tell.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireReminderAuthorization } from "../reminders/reminder-context.js";
import { reminderRepository } from "../reminders/reminder-repository.js";
import { withCallExamples, type CallExamples } from "../tool-call-examples.js";
import { TIMEZONE_BASIS_MAX_LENGTH } from "../reminders/reminder-validation.js";
import {
  requireAction,
  requiredEnum,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_NOTIFICATION_SETTINGS_INPUT_INVALID";
const TOOL_ACTIONS = ["get", "set"] as const;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const SOURCES = ["person", "agent"] as const;
const TOP_LEVEL_FIELDS = ["action", "basis", "quietEnd", "quietStart", "source", "timezone"] as const;

const nullableTimeSchema = z.union([z.string(), z.null()]).optional();
const notificationSettingsSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Required action: get or set."),
  basis: z.string().optional().describe("For source=agent only: what the zone was read from, in Russian, for example «город Тула из разговора»."),
  quietEnd: nullableTimeSchema.describe("Optional, together with quietStart: HH:MM, or null to turn quiet hours off; leave both out to keep them."),
  quietStart: nullableTimeSchema.describe("Optional, together with quietEnd: HH:MM, or null to turn quiet hours off; leave both out to keep them."),
  source: z.enum(SOURCES).optional().describe("Required for action=set: person when the person named or confirmed the zone, agent when you read it from a clear sign."),
  timezone: z.string().optional().describe("A required IANA timezone, only for action=set."),
}).strict();

function optionalNullableTime(input: Record<string, unknown>, key: "quietEnd" | "quietStart"): string | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Поле ${key} должно быть null или временем в формате ЧЧ:ММ, например 22:00`,
    );
  }
  return value;
}

function requireSetInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "basis", "quietEnd", "quietStart", "source", "timezone"], "action=set", INPUT_ERROR_CODE);
  const quietStart = optionalNullableTime(input, "quietStart");
  const quietEnd = optionalNullableTime(input, "quietEnd");
  const bothKept = quietStart === undefined && quietEnd === undefined;
  const bothDisabled = quietStart === null && quietEnd === null;
  const bothConfigured = typeof quietStart === "string" && typeof quietEnd === "string" && quietStart !== quietEnd;
  if (!bothKept && !bothDisabled && !bothConfigured) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Передайте quietStart и quietEnd вместе разными значениями ЧЧ:ММ, оба null, чтобы отключить тихие часы, или не передавайте их",
    );
  }
  const source = requiredEnum(input, "source", SOURCES, INPUT_ERROR_CODE);
  const basis = source === "agent"
    ? requiredString(input, "basis", INPUT_ERROR_CODE, "город Тула из разговора", { maxLength: TIMEZONE_BASIS_MAX_LENGTH })
    : null;
  return {
    basis,
    ...(bothKept ? {} : { quietEnd, quietStart }),
    source,
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
  "Get or set the person's IANA timezone and quiet hours for reminders.",
  "Get: {\"action\":\"get\"}; its source says whether the person named the zone or you read it from a sign.",
  "Set with source person when the person named or confirmed where they are: {\"action\":\"set\",\"timezone\":\"Asia/Yerevan\",\"source\":\"person\"}.",
  "Set with source agent only when no zone is set yet and the person's place is clear: they named the city or region where they are now, shared their own location, or a memory record says where they live; never from the language or from relatives' zones. Pass basis: {\"action\":\"set\",\"timezone\":\"Europe/Moscow\",\"source\":\"agent\",\"basis\":\"город Тула из разговора\"}.",
  "Quiet hours are set only when the person asks: quietStart and quietEnd together as two different HH:MM, both null to turn them off, or left out to keep them.",
  "The result gives localTimeNow and the reminders this changed: activated were waiting and are now set; missed lost their time; expiredRecently ended unanswered earlier; shifted and shiftedIntoPast were moved from a guessed zone. Tell the person about each.",
].join(" ");

export const NOTIFICATION_SETTINGS_CALL_EXAMPLES: CallExamples = {
  get: { action: "get" },
  set: { action: "set", timezone: "Europe/Moscow", source: "person" },
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
