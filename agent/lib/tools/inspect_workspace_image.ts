/**
 * Persistent workspace image inspection tool.
 *
 * Export:
 * - `inspect_workspace_image` tool over a path, Telegram inbox, or opaque journal reference.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root anyOf in tool descriptors.
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
    .describe("The attachment UUID from <telegram_attachment_refs> or the log; do not pass it together with path or telegramMessageId")
    .optional(),
  path: z.string().min(1).max(512)
    .describe("A path relative to the root of the chosen scope, for example photos/image.png; do not prepend the scope name")
    .optional(),
  question: z.string().min(1).max(4_000)
    .describe("A required specific question to the vision model about the image"),
  scope: z.enum(SCOPES)
    .describe("The required scope whose root path is resolved against"),
  telegramMessageId: z.string().regex(TELEGRAM_MESSAGE_ID_PATTERN)
    .describe("The numeric ID of the current Telegram message; do not pass it together with attachmentId or path")
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
  "When to use: answer a specific question about an image from the workspace or Telegram through the vision model.",
  "When not to use: do not pass several sources and do not use the tool for non-graphic files.",
  "Input: for the reply ancestry or <telegram_attachment_refs> pass attachmentId; for the current Telegram attachment use {\"telegramMessageId\":\"773\",\"scope\":\"personal\",\"question\":\"Что изображено?\"}; for a file use a relative path {\"path\":\"photos/image.png\",\"scope\":\"personal\",\"question\":\"Что изображено?\"}. Pass exactly one source.",
  "Result: analysis, the actual path and scope; the analysis does not save Telegram bytes to the workspace.",
  "Error: fix the source or the question only if retryable=true; do not repeat a provider failure automatically.",
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
