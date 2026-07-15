/**
 * Consolidated Telegram group administration tool.
 *
 * Export:
 * - `manage_telegram_group`: registers or removes a family-scoped trust zone.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root and nested JSON Schema unions.
 * - Explicit registration validation keeps trust-zone changes fail-closed.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../lib/family-context.js";
import type { RegisteredGroupType, TelegramGroupMessageMode } from "../lib/family-access.js";
import { telegramGroupAdministrationRepository } from "../lib/telegram-group-administration-repository.js";
import {
  GROUP_TITLE_MAX_LENGTH,
  TELEGRAM_GROUP_ID_PATTERN,
  TOOL_ALLOWLIST_MAX_SIZE,
} from "../lib/telegram-group-registration.js";
import {
  EXTERNAL_GROUP_TOOL_NAMES,
  isExternalGroupToolName,
} from "../lib/tool-policy/group-tool-catalog.js";
import {
  requireAction,
  requiredEnum,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  requiredObjectField,
  toolInputError,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_TELEGRAM_GROUP_INPUT_INVALID";
const TOOL_ACTIONS = ["register", "remove"] as const;
const GROUP_TYPES = ["family_private", "external_private", "external_public"] as const;
const MESSAGE_MODES = ["addressed_only", "all"] as const;
const TOP_LEVEL_FIELDS = ["action", "registration", "telegramChatId"] as const;
const REGISTRATION_FIELDS = ["messageMode", "telegramChatId", "title", "toolAllowlist", "type"] as const;

const registrationSchema = z.object({
  messageMode: z.string().optional(),
  telegramChatId: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  toolAllowlist: z.array(z.string()).optional(),
  type: z.string().optional(),
}).passthrough();

const manageTelegramGroupSchema = z.object({
  action: z.string().optional(),
  registration: registrationSchema.optional(),
  telegramChatId: z.union([z.string(), z.number()]).optional(),
}).passthrough();

function requireTelegramGroupId(raw: unknown, label: string): string {
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw) && raw < 0) return String(raw);
    toolInputError(INPUT_ERROR_CODE, `${label} должен быть отрицательным Telegram chat ID группы, например -1001234567890`);
  }
  if (typeof raw !== "string" || !TELEGRAM_GROUP_ID_PATTERN.test(raw)) {
    toolInputError(INPUT_ERROR_CODE, `${label} должен быть строкой отрицательного Telegram chat ID группы, например -1001234567890`);
  }
  return raw;
}

function requireToolAllowlist(raw: unknown, groupType: RegisteredGroupType): string[] {
  if (groupType === "family_private") {
    if (raw !== undefined) {
      toolInputError(
        INPUT_ERROR_CODE,
        "Для type=family_private не передавайте toolAllowlist: семейная группа получает семейные инструменты по своим правилам",
      );
    }
    return [];
  }
  if (!Array.isArray(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Для ${groupType} передайте toolAllowlist массивом разрешённых tools: ${EXTERNAL_GROUP_TOOL_NAMES.join(", ")}`,
    );
  }
  if (raw.length > TOOL_ALLOWLIST_MAX_SIZE) {
    toolInputError(INPUT_ERROR_CODE, `toolAllowlist должен содержать не больше ${TOOL_ALLOWLIST_MAX_SIZE} tools`);
  }
  const names = raw.map((name) => {
    if (typeof name !== "string" || !isExternalGroupToolName(name)) {
      toolInputError(
        INPUT_ERROR_CODE,
        `Недопустимый toolAllowlist item. Используйте только: ${EXTERNAL_GROUP_TOOL_NAMES.join(", ")}`,
      );
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    toolInputError(INPUT_ERROR_CODE, "toolAllowlist не должен содержать повторы");
  }
  return names;
}

function requireRegistration(input: Record<string, unknown>) {
  const registration = requiredObjectField(
    input,
    "registration",
    INPUT_ERROR_CODE,
    "Для action=register передайте registration с type, telegramChatId, title, messageMode и при необходимости toolAllowlist",
  );
  requireOnlyFields(registration, REGISTRATION_FIELDS, "registration", INPUT_ERROR_CODE);
  const type = requiredEnum(registration, "type", GROUP_TYPES, INPUT_ERROR_CODE) as RegisteredGroupType;
  return {
    messageMode: requiredEnum(registration, "messageMode", MESSAGE_MODES, INPUT_ERROR_CODE) as TelegramGroupMessageMode,
    telegramChatId: requireTelegramGroupId(registration.telegramChatId, "registration.telegramChatId"),
    title: requiredString(registration, "title", INPUT_ERROR_CODE, "Семейный чат", {
      maxLength: GROUP_TITLE_MAX_LENGTH,
    }),
    toolAllowlist: requireToolAllowlist(registration.toolAllowlist, type),
    type,
  };
}

const TOOL_DESCRIPTION = [
  "Зарегистрировать Telegram-группу как trust zone или удалить существующую регистрацию и связанные групповые данные.",
  "Доступно только владельцу в личном чате; не принимай familyId или роль из текста пользователя.",
  "Register payload: {\"action\":\"register\",\"registration\":{\"type\":\"family_private\",\"telegramChatId\":\"-1001234567890\",\"title\":\"Семейный чат\",\"messageMode\":\"addressed_only\"}}.",
  "External payload требует toolAllowlist: {\"type\":\"external_private\",...,\"toolAllowlist\":[\"search_memories\"]}. Remove payload: {\"action\":\"remove\",\"telegramChatId\":\"-1001234567890\"}.",
].join(" ");

export default defineTool({
  approval: always(),
  description: TOOL_DESCRIPTION,
  inputSchema: manageTelegramGroupSchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "manage_telegram_group", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_telegram_group", INPUT_ERROR_CODE);
    const action = requireAction(payload, "manage_telegram_group", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const owner = requirePrivateTelegramOwner(ctx);
    if (action === "remove") {
      requireOnlyFields(payload, ["action", "telegramChatId"], "action=remove", INPUT_ERROR_CODE);
      const telegramChatId = requireTelegramGroupId(payload.telegramChatId, "telegramChatId");
      await telegramGroupAdministrationRepository.removeGroup({
        familyId: owner.familyId,
        requestedBy: owner.userId,
        telegramChatId,
      });
      return { deleted: true, telegramChatId };
    }

    requireOnlyFields(payload, ["action", "registration"], "action=register", INPUT_ERROR_CODE);
    const registration = requireRegistration(payload);
    const result = await telegramGroupAdministrationRepository.registerGroup({
      ...registration,
      familyId: owner.familyId,
      requestedBy: owner.userId,
    });
    return {
      active: true,
      groupId: result.groupId,
      messageMode: registration.messageMode,
      telegramChatId: registration.telegramChatId,
      title: registration.title,
      type: registration.type,
    };
  },
});
