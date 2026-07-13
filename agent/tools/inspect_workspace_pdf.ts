/**
 * Persistent workspace PDF inspection tool.
 *
 * Export:
 * - Eve `inspect_workspace_pdf` tool for a three-page Qwen vision batch.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireWorkspaceAuthorization } from "../lib/workspaces/workspace-context.js";
import { inspectWorkspacePdf } from "../lib/workspaces/workspace-pdf-inspection.js";

export default defineTool({
  description: "Показать vision-модели до трёх последовательных страниц сохранённого PDF.",
  inputSchema: z.object({
    path: z.string().min(1).max(512),
    question: z.string().min(1).max(4_000),
    scope: z.enum(["personal", "family", "group"]),
    startPage: z.number().int().positive(),
  }),
  async execute(input, ctx) {
    return await inspectWorkspacePdf(requireWorkspaceAuthorization(ctx), {
      ...input,
      abortSignal: ctx.abortSignal,
    });
  },
});
