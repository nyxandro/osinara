/** Structured Gmail message mutations over one bounded batch with semantic approval. */
import type { ToolContext } from "../../runtime/tool.js";
import { defineTool } from "../../runtime/tool.js";

import {
  GMAIL_MESSAGE_BATCH_MAX,
  gmailMessageInputSchema,
  gmailMessageMutationArgv,
  type GmailMessageInput,
  requireGmailMessageInput,
} from "../google-workspace/gmail-message-contract.js";
import { executeGoogleWorkspace } from "../google-workspace/google-workspace-executor.js";
import { groupApprovalDenial } from "../telegram-hitl/approval-surface.js";

interface GmailMessageManagerDependencies {
  execute(
    input: { argv: string[]; expectedProfileRef: string },
    ctx: ToolContext,
  ): Promise<unknown>;
}

export function createGmailMessageManager(dependencies: GmailMessageManagerDependencies) {
  return async function manageGmailMessage(input: GmailMessageInput, ctx: ToolContext) {
    const parsed = requireGmailMessageInput(input);
    return await dependencies.execute({
      argv: gmailMessageMutationArgv(parsed),
      expectedProfileRef: parsed.profileRef,
    }, ctx);
  };
}

const manageGmailMessage = createGmailMessageManager({ execute: executeGoogleWorkspace });

export default defineTool({
  approval: ({ session, toolInput }) => {
    requireGmailMessageInput(toolInput);
    return groupApprovalDenial({ session }) ?? "user-approval";
  },
  description: [
    `Change the state of up to ${GMAIL_MESSAGE_BATCH_MAX} exact Gmail messages in one call: trash, delete forever, restore, mark read or unread.`,
    "Only on the user's direct request; copy messageIds and profileRef unchanged from the Gmail result. \"Удали\" without the word \"навсегда\" means trash.",
    `Pass all selected messages in one call, not one by one; if there are more than ${GMAIL_MESSAGE_BATCH_MAX}, process the first ${GMAIL_MESSAGE_BATCH_MAX} and ask whether to continue. Not for reading or searching.`,
    "Osinara itself shows the senders and subjects in the mandatory confirmation: do not retell the list in the chat and do not ask for confirmation in text unless the user asked to show the list.",
    "Done for the whole batch only with completed=true; do not repeat automatically.",
  ].join(" "),
  inputSchema: gmailMessageInputSchema,
  async execute(input, ctx) {
    return await manageGmailMessage(input, ctx);
  },
});
