/**
 * Restricted external-group file deletion capability.
 *
 * Export:
 * - `removeGroupFileTool`: approval-gated deletion confined to the verified group mount.
 */
import { defineTool } from "../../runtime/tool.js";
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
    "Irreversibly delete one file from the workspace of the current external group.",
    "Pass path relative to the root of the group scope, for example reports/result.pdf; do not prepend group to the path.",
  ].join(" "),
  inputSchema: z.object({
    path: z.string().min(1).max(512).describe(
      "A relative path inside the group workspace without /workspace/group, for example reports/result.md.",
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
