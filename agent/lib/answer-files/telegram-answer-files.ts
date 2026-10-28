/**
 * The answer-file boundary of a Telegram turn.
 *
 * Exports:
 * - `answerWorkspaceAuthorization`: workspace rights from the verified session, or null where the
 *   chat has no workspace at all.
 * - `checkTelegramAnswerFiles`: the runtime's pre-delivery check of a final answer.
 * - `prepareTelegramAnswerFiles`: the answer laid out for delivery, files that cannot go logged.
 *
 * Key construct:
 * - Only a turn that answers a Telegram chat delivers files. A delegated child answers its parent:
 *   its file paths are text the parent may show in its own answer, where they are checked.
 */
import type { SessionAuth } from "../../runtime/context.js";
import type { StepStartContext } from "../../runtime/agent-definition.js";

import { isAppError } from "../app-error.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { answerFilesNotice } from "./answer-file-check.js";
import { prepareAnswerFiles, type PreparedTelegramAnswer } from "./answer-file-delivery.js";
import { answerFileResolver } from "./answer-file-resolution.js";

export function answerWorkspaceAuthorization(session: { readonly auth: SessionAuth }): WorkspaceAuthorization | null {
  try {
    return requireWorkspaceAuthorization({ session });
  } catch (error) {
    if (isAppError(error) && error.code === "AGENT_WORKSPACE_CONTEXT_INVALID") return null;
    throw error;
  }
}

export async function checkTelegramAnswerFiles(
  context: StepStartContext & { readonly text: string },
): Promise<string | undefined> {
  if (context.channel.kind !== "telegram" || context.session.parent !== undefined) return undefined;
  return await answerFilesNotice({
    auth: () => answerWorkspaceAuthorization(context.session),
    resolver: answerFileResolver,
    text: context.text,
  });
}

export async function prepareTelegramAnswerFiles(input: {
  readonly agentTurnId: string;
  readonly markdown: string;
  readonly session: { readonly auth: SessionAuth };
}): Promise<PreparedTelegramAnswer> {
  const answer = await prepareAnswerFiles({
    auth: () => answerWorkspaceAuthorization(input.session),
    markdown: input.markdown,
    resolver: answerFileResolver,
    turnId: input.agentTurnId,
  });
  if (answer.problems.length > 0) {
    // The model was asked to fix these before; the person now sees a line in place of each.
    console.error(JSON.stringify({
      agentTurnId: input.agentTurnId,
      code: "AGENT_ANSWER_FILES_NOT_ATTACHED",
      problems: answer.problems.map((problem) => problem.code),
    }));
  }
  return answer;
}
