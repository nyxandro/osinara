/**
 * Typed model-facing Google Workspace execution boundary.
 *
 * Exports:
 * - `execute_google_workspace`: reviewed argv execution with input-aware approval.
 */
import { defineTool } from "../../runtime/tool.js";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { classifyModelFacingGoogleWorkspaceCommand } from "../google-workspace/google-workspace-command-policy.js";
import { groupApprovalDenial } from "../telegram-hitl/approval-surface.js";
import {
  executeGoogleWorkspace,
} from "../google-workspace/google-workspace-executor.js";

export { createGoogleWorkspaceExecutor } from "../google-workspace/google-workspace-executor.js";

const commandSchema = z.object({
  argv: z.array(z.string().min(1).max(64 * 1024)).min(1).max(128).describe(
    "Exact gws arguments without the binary name or shell quoting; the API resource and method go as separate elements"
  ),
}).strict();

export default defineTool({
  approval: ({ session, toolInput }) => {
    try {
      if (classifyModelFacingGoogleWorkspaceCommand(toolInput?.argv ?? []) !== "mutation") {
        return "not-applicable";
      }
      return groupApprovalDenial({ session }) ?? "user-approval";
    } catch (error) {
      return {
        type: "denied",
        reason: error instanceof AppError
          ? error.message
          : "AGENT_GOOGLE_WORKSPACE_COMMAND_FORBIDDEN: Команда отсутствует в allowlist",
      };
    }
  },
  description:
    "Run a permitted Google Workspace command in the current personal/family profile. This is the only way to run gws; Bash has neither the binary nor the Google profile. Pass the exact argv without gws. For unread mail: [\"gmail\",\"+triage\",\"--max\",\"20\",\"--labels\"]. For the calendar: [\"calendar\",\"+agenda\",\"--today\"] (set the period and timezone by the task). The + sign is required for a helper. Pass the API resource and method as separate elements: [\"gmail\",\"users\",\"messages\",\"list\",\"--params\",\"{\\\"userId\\\":\\\"me\\\",\\\"q\\\":\\\"is:unread\\\"}\"]. Help: [\"schema\",\"gmail.users.messages.list\"] or [\"schema\",\"calendar.events.list\"]. Change the state of Gmail messages only through manage_gmail_message: all selected messages in one call, up to 30 messageIds, together with the profileRef from the read result unchanged. A mutation automatically requires a person's confirmation with all arguments and must take no more than 3000 characters in its JSON form. File arguments are unavailable.",
  inputSchema: commandSchema,
  async execute(input, ctx) {
    classifyModelFacingGoogleWorkspaceCommand(input.argv);
    return await executeGoogleWorkspace(input, ctx);
  },
});
