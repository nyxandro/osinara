/**
 * Persistent workspace image inspection tool.
 *
 * Export:
 * - Eve `inspect_workspace_image` tool for Qwen vision over an authorized stored image.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireWorkspaceAuthorization } from "../lib/workspaces/workspace-context.js";
import { inspectWorkspaceImage } from "../lib/workspaces/workspace-image-inspection.js";

export default defineTool({
  description: "Повторно открыть сохранённое изображение из workspace и ответить на вопрос через vision-модель.",
  inputSchema: z.object({
    path: z.string().min(1).max(512),
    question: z.string().min(1).max(4_000),
    scope: z.enum(["personal", "family", "group"]),
  }),
  async execute(input, ctx) {
    return await inspectWorkspaceImage(requireWorkspaceAuthorization(ctx), {
      ...input,
      abortSignal: ctx.abortSignal,
    });
  },
});
