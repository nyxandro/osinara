/**
 * Channel lifecycle of a wake-up turn inside its chat's own conversation.
 *
 * Exports:
 * - `isConversationWakeupTurn`: whether the current turn was started by a wake-up.
 * - `admitConversationWakeupTurn`: binds the starting Eve turn to its run.
 * - `finishConversationWakeupTurn`: closes the run when the turn completes, fails, or is cancelled.
 *
 * A wake-up turn otherwise behaves as an ordinary turn of that conversation: its final answer is
 * delivered, recorded in the chat history, and routed like any other.
 */
import type { SessionContext } from "eve/context";

import { applicationSessionId } from "../sessions/session-context.js";
import { conversationWakeupRunRepository } from "./conversation-wakeup-run-repository.js";
import { conversationWakeupRunId } from "./conversation-wakeup-turn.js";

type TurnContext = Pick<SessionContext, "session">;

export function isConversationWakeupTurn(ctx: TurnContext): boolean {
  return !ctx.session.parent && conversationWakeupRunId(ctx.session.auth) !== null;
}

export async function admitConversationWakeupTurn(ctx: TurnContext): Promise<void> {
  const runId = conversationWakeupRunId(ctx.session.auth);
  if (ctx.session.parent || runId === null) return;
  await conversationWakeupRunRepository.admitTurn({
    applicationSessionId: applicationSessionId(ctx),
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
    runId,
  });
}

export async function finishConversationWakeupTurn(ctx: TurnContext, failureCode: string | null): Promise<void> {
  const runId = conversationWakeupRunId(ctx.session.auth);
  if (ctx.session.parent || runId === null) return;
  const finished = await conversationWakeupRunRepository.finishTurn({
    applicationSessionId: applicationSessionId(ctx),
    completedAt: new Date(),
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
    failureCode,
    runId,
  });
  // A replayed terminal event finds its run already closed; the first one did the work.
  if (!finished) console.info(JSON.stringify({ code: "AGENT_CONVERSATION_WAKEUP_RUN_ALREADY_CLOSED", runId }));
}
