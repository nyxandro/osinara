/**
 * Persistent workspace image inspection tool.
 *
 * Export:
 * - Eve `inspect_workspace_image` tool for Qwen vision over a path or Telegram inbox reference.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireWorkspaceAuthorization } from "../lib/workspaces/workspace-context.js";
import { inspectWorkspaceImage } from "../lib/workspaces/workspace-image-inspection.js";

export default defineTool({
  description: "Открыть изображение из workspace по пути или ID входящего сообщения Telegram и ответить через vision-модель.",
  inputSchema: z.union([
    z.strictObject({
      path: z.string().min(1).max(512),
      question: z.string().min(1).max(4_000),
      scope: z.enum(["personal", "family", "group"]),
    }),
    z.strictObject({
      question: z.string().min(1).max(4_000),
      scope: z.enum(["personal", "family", "group"]),
      telegramMessageId: z.string().regex(/^\d+$/u),
    }),
  ]),
  async execute(input, ctx) {
    return await inspectWorkspaceImage(requireWorkspaceAuthorization(ctx), {
      ...input,
      abortSignal: ctx.abortSignal,
    });
  },
});
