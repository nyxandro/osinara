/**
 * Structured Gmail message mutations over one bounded batch: in a live turn they run without a
 * confirmation card; a scenario run is refused, since nobody is there to see it.
 */
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
import { googleWorkspaceChangeRefusal } from "../google-workspace/google-workspace-live-turn.js";

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
  approval: ({ session }) => {
    const refusal = googleWorkspaceChangeRefusal({ session });
    return refusal ? { reason: refusal.message, type: "denied" } : "not-applicable";
  },
  description: [
    `Change the state of up to ${GMAIL_MESSAGE_BATCH_MAX} exact Gmail messages in one call: trash, delete forever, restore, mark read or unread.`,
    "Only on the user's direct request; copy messageIds and profileRef unchanged from the Gmail result. \"Удали\" without the word \"навсегда\" means trash.",
    `Pass all selected messages in one call, not one by one; if there are more than ${GMAIL_MESSAGE_BATCH_MAX}, continue with the next calls without asking. Not for reading or searching.`,
    "List the messages first only if the user asked to see them. A scenario run only reads.",
    "Done for a batch only with completed=true; do not repeat a batch automatically.",
  ].join(" "),
  inputSchema: gmailMessageInputSchema,
  async execute(input, ctx) {
    const refusal = googleWorkspaceChangeRefusal(ctx);
    if (refusal) throw refusal;
    return await manageGmailMessage(input, ctx);
  },
});
