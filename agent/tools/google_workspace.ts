/**
 * Google Workspace model-facing integration tool.
 *
 * Export:
 * - `google_workspace`: connects a user account or invokes a structured gws Discovery method.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireGoogleWorkspaceAuthorization } from "../lib/google-workspace/google-workspace-context.js";
import {
  googleWorkspaceCommandSchema,
  isGoogleWorkspaceReadOnlyCommand,
} from "../lib/google-workspace/google-workspace-command.js";
import { executeGoogleWorkspaceCommand } from "../lib/google-workspace/google-workspace-execution.js";
import { startGoogleWorkspaceAuthorization } from "../lib/google-workspace/google-oauth-service.js";

const workspaceFileSchema = z.object({
  path: z.string().min(1).max(512),
  scope: z.enum(["personal", "family"]),
}).strict();
const googleWorkspaceToolSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect") }).strict(),
  z.object({
    action: z.literal("execute"),
    command: googleWorkspaceCommandSchema.omit({ uploadContentType: true }),
    output: workspaceFileSchema.optional(),
    upload: workspaceFileSchema.extend({
      contentType: z.string().min(1).max(200),
    }).strict().optional(),
  }).strict(),
]);

export default defineTool({
  approval: ({ toolInput }) => {
    if (toolInput?.action !== "execute") return "not-applicable";
    if (toolInput.upload) return "user-approval";
    return isGoogleWorkspaceReadOnlyCommand(toolInput.command)
      ? "not-applicable"
      : "user-approval";
  },
  description:
    "Подключить личный Google Workspace или выполнить Drive, Docs, Sheets, Calendar, Gmail, Tasks и Chat API через структурированную команду gws. Изменения всегда подтверждаются пользователем.",
  inputSchema: googleWorkspaceToolSchema,
  async execute(input, ctx) {
    const authorization = requireGoogleWorkspaceAuthorization(ctx);
    if (input.action === "connect") {
      return await startGoogleWorkspaceAuthorization(authorization);
    }
    return await executeGoogleWorkspaceCommand(authorization, input, ctx.callId);
  },
});
