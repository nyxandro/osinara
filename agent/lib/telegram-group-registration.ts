/**
 * Telegram group registration input contract.
 *
 * Exports:
 * - Group registration constants: validate Telegram IDs, titles, and allowlists.
 * - `telegramGroupIdSchema`: validates group/supergroup Telegram chat IDs.
 * - `telegramGroupRegistrationInputSchema`: validates and normalizes model tool input.
 */
import { z } from "zod";

import { GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES } from "./tool-policy/grantable-group-capabilities.js";

export const TELEGRAM_GROUP_ID_PATTERN = /^-[1-9]\d*$/;
export const GROUP_TITLE_MAX_LENGTH = 200;
export const TOOL_ALLOWLIST_MAX_SIZE = 50;
export const TELEGRAM_GROUP_TITLE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export const telegramGroupIdSchema = z
  // PostgreSQL and Telegram boundaries use strings so large identifiers are never rounded by JSON.
  .string()
  .regex(TELEGRAM_GROUP_ID_PATTERN);

const commonRegistrationSchema = z.object({
  telegramChatId: telegramGroupIdSchema,
  title: z.string().min(1).max(GROUP_TITLE_MAX_LENGTH).refine(
    (title) => !TELEGRAM_GROUP_TITLE_CONTROL_PATTERN.test(title),
  ),
});

const standardMessageModeSchema = z.enum(["addressed_only", "all"]);
const externalMessageModeSchema = z
  .enum(["addressed_only", "all", "owner_only"])
  .describe(
    "owner_only сохраняет доставленную историю для контекста, но запускает агента только для текущего владельца Osinara",
  );

// Only capabilities the active model provider can actually serve are grantable, so a provider that
// lacks one never gets a persisted grant that would sit inert in the trust zone.
const externalToolAllowlistSchema = z
  .array(z.enum(GRANTABLE_EXTERNAL_GROUP_TOOL_NAMES))
  .max(TOOL_ALLOWLIST_MAX_SIZE)
  .describe(
    "Дополнительные application tools внешней группы; glob, grep, read_file и write_file доступны в её изолированном workspace всегда",
  )
  .refine((names) => new Set(names).size === names.length, {
    message: "AGENT_GROUP_TOOL_ALLOWLIST_DUPLICATE: Список инструментов содержит повторы",
  });

export const telegramGroupRegistrationInputSchema = z.discriminatedUnion("type", [
  commonRegistrationSchema
    .extend({
      messageMode: standardMessageModeSchema,
      toolAllowlist: z.never().optional(),
      type: z.literal("family_private"),
    })
    .strict(),
  commonRegistrationSchema
    .extend({
      messageMode: externalMessageModeSchema,
      toolAllowlist: externalToolAllowlistSchema,
      type: z.literal("external"),
    })
    .strict(),
]);
