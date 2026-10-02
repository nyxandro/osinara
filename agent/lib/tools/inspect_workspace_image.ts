/**
 * Persistent workspace image inspection tool.
 *
 * Export:
 * - Eve `inspect_workspace_image` tool over a path, Telegram inbox, or opaque journal reference.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root anyOf in Eve descriptors.
 * - Input validation enforces exactly one image source before workspace authorization.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { inspectWorkspaceImage } from "../workspaces/workspace-image-inspection.js";
import {
  requireInputRecord,
  requireOnlyFields,
  requiredEnum,
  requiredString,
  requiredUuid,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_WORKSPACE_IMAGE_INPUT_INVALID";
const SCOPES = ["personal", "family", "group"] as const;
const TOP_LEVEL_FIELDS = ["attachmentId", "path", "question", "scope", "telegramMessageId"] as const;
const TELEGRAM_MESSAGE_ID_PATTERN = /^\d+$/u;

const inspectWorkspaceImageSchema = z.object({
  attachmentId: z.uuid()
    .describe("UUID вложения из <telegram_attachment_refs> или журнала; не передавай вместе с path или telegramMessageId")
    .optional(),
  path: z.string().min(1).max(512)
    .describe("Путь относительно корня выбранного scope, например photos/image.png; не добавляй имя scope в начало")
    .optional(),
  question: z.string().min(1).max(4_000)
    .describe("Обязательный конкретный вопрос к vision-модели об изображении"),
  scope: z.enum(SCOPES)
    .describe("Обязательная область, относительно корня которой разрешается path"),
  telegramMessageId: z.string().regex(TELEGRAM_MESSAGE_ID_PATTERN)
    .describe("Числовой ID текущего Telegram-сообщения; не передавай вместе с attachmentId или path")
    .optional(),
}).passthrough();

function requireImageInput(input: Record<string, unknown>) {
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "inspect_workspace_image", INPUT_ERROR_CODE);
  const path = input.path;
  const attachmentId = input.attachmentId;
  const telegramMessageId = input.telegramMessageId;
  const hasPath = path !== undefined;
  const hasTelegramMessageId = telegramMessageId !== undefined;
  const sourceCount = [attachmentId, path, telegramMessageId].filter((value) => value !== undefined).length;
  if (sourceCount !== 1) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для inspect_workspace_image передайте ровно один источник: attachmentId, path или telegramMessageId",
    );
  }
  const common = {
    question: requiredString(input, "question", INPUT_ERROR_CODE, "Что изображено?", { maxLength: 4_000 }),
    scope: requiredEnum(input, "scope", SCOPES, INPUT_ERROR_CODE),
  };
  if (attachmentId !== undefined) {
    return {
      ...common,
      attachmentId: requiredUuid(input, "attachmentId", INPUT_ERROR_CODE, "attachmentId"),
    };
  }
  if (hasPath) {
    return {
      ...common,
      path: requiredString(input, "path", INPUT_ERROR_CODE, "photos/image.png", { maxLength: 512 }),
    };
  }
  const messageId = requiredString(input, "telegramMessageId", INPUT_ERROR_CODE, "773");
  if (!TELEGRAM_MESSAGE_ID_PATTERN.test(messageId)) {
    toolInputError(INPUT_ERROR_CODE, "telegramMessageId должен быть строкой с числовым ID сообщения Telegram, например \"773\"");
  }
  return { ...common, telegramMessageId: messageId };
}

const TOOL_DESCRIPTION = [
  "Когда использовать: ответить на конкретный вопрос об изображении из workspace или Telegram через vision-модель.",
  "Не использовать: не передавай несколько источников и не используй tool для не-графических файлов.",
  "Вход: для reply ancestry или <telegram_attachment_refs> передай attachmentId; для текущего Telegram-вложения используй {\"telegramMessageId\":\"773\",\"scope\":\"personal\",\"question\":\"Что изображено?\"}; для файла используй относительный path {\"path\":\"photos/image.png\",\"scope\":\"personal\",\"question\":\"Что изображено?\"}. Передавай ровно один источник.",
  "Результат: analysis, фактические path и scope; анализ не сохраняет Telegram bytes в workspace.",
  "Ошибка: исправь источник или вопрос только если retryable=true; provider failure автоматически не повторяй.",
].join(" ");

export default defineTool({
  // Repeating it after a crash is safe: it only reads.
  replaySafe: true,
  description: TOOL_DESCRIPTION,
  inputSchema: inspectWorkspaceImageSchema,
  async execute(input, ctx) {
    const payload = requireImageInput(requireInputRecord(input, "inspect_workspace_image", INPUT_ERROR_CODE));
    return await inspectWorkspaceImage(requireWorkspaceAuthorization(ctx), {
      ...payload,
      abortSignal: ctx.abortSignal,
    });
  },
});
