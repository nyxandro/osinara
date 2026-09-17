/**
 * Restricted external-group file deletion capability.
 *
 * Export:
 * - `removeGroupFileTool`: approval-gated deletion confined to the verified group mount.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { groupApprovalDenial } from "../telegram-hitl/approval-surface.js";
import { requireWorkspaceAuthorization } from "./workspace-context.js";
import { validateWorkspacePath } from "./workspace-path.js";
import { workspaceRepository } from "./workspace-repository.js";

export const removeGroupFileTool = defineTool({
  approval: ({ session, toolInput }) => {
    validateWorkspacePath(toolInput?.path ?? "");
    return groupApprovalDenial({ session }) ?? "user-approval";
  },
  description: [
    "Безвозвратно удалить один файл из workspace текущей внешней группы.",
    "Передавай path относительно корня group scope, например reports/result.pdf; не добавляй group в начало пути.",
  ].join(" "),
  inputSchema: z.object({
    path: z.string().min(1).max(512).describe(
      "Относительный путь внутри group workspace без /workspace/group, например reports/result.md.",
    ),
  }).strict(),
  async execute(input, ctx) {
    return await workspaceRepository.deleteFile(
      requireWorkspaceAuthorization(ctx),
      "group",
      input.path,
      ctx.callId,
    );
  },
});
