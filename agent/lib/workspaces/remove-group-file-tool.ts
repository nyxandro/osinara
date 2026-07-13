/**
 * Restricted external-group file deletion capability.
 *
 * Export:
 * - `removeGroupFileTool`: approval-gated deletion confined to the verified group mount.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { requireWorkspaceAuthorization } from "./workspace-context.js";
import { workspaceRepository } from "./workspace-repository.js";

export const removeGroupFileTool = defineTool({
  approval: always(),
  description: "Безвозвратно удалить один файл из workspace текущей внешней группы.",
  inputSchema: z.object({ path: z.string().min(1).max(512) }).strict(),
  async execute(input, ctx) {
    return await workspaceRepository.deleteFile(
      requireWorkspaceAuthorization(ctx),
      "group",
      input.path,
      ctx.callId,
    );
  },
});
