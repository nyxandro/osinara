/**
 * Telegram group registration input contract.
 *
 * Exports:
 * - `telegramGroupIdSchema`: validates group/supergroup Telegram chat IDs.
 * - `telegramGroupRegistrationInputSchema`: validates and normalizes model tool input.
 */
import { z } from "zod";

import { EXTERNAL_GROUP_TOOL_NAMES } from "./tool-policy/group-tool-catalog.js";

const TELEGRAM_GROUP_ID_PATTERN = /^-[1-9]\d*$/;
const GROUP_TITLE_MAX_LENGTH = 200;
const TOOL_ALLOWLIST_MAX_SIZE = 50;

export const telegramGroupIdSchema = z
  .union([
    z.string().regex(TELEGRAM_GROUP_ID_PATTERN),
    z.number().int().safe().negative(),
  ])
  // PostgreSQL and Telegram repository boundaries use strings to preserve identifiers exactly.
  .transform((value) => String(value));

const commonRegistrationSchema = z.object({
  messageMode: z
    .enum(["addressed_only", "all"])
    .describe(
      "addressed_only отвечает только на команды, упоминания и ответы; all дополнительно хранит обычные сообщения как контекст",
    ),
  telegramChatId: telegramGroupIdSchema,
  title: z.string().min(1).max(GROUP_TITLE_MAX_LENGTH),
});

const externalToolAllowlistSchema = z
  .array(z.enum(EXTERNAL_GROUP_TOOL_NAMES))
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
      toolAllowlist: z.never().optional(),
      type: z.literal("family_private"),
    })
    .strict(),
  commonRegistrationSchema
    .extend({
      toolAllowlist: externalToolAllowlistSchema,
      type: z.literal("external_private"),
    })
    .strict(),
  commonRegistrationSchema
    .extend({
      toolAllowlist: externalToolAllowlistSchema,
      type: z.literal("external_public"),
    })
    .strict(),
]);
