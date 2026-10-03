/**
 * Creating the turn of a wake-up in its chat's own conversation.
 *
 * Exports:
 * - `createConversationWakeupTurn`: in one transaction, creates the turn in the conversation's
 *   session and the wake-up's record of it (dispatch, admission deadline, turn id).
 * - `WAKEUP_SESSION_INACTIVE_CODE`: the conversation has no runtime session to continue.
 *
 * The turn carries the dispatch and the admission deadline a Telegram message's turn carries
 * (`conversationWakeupAuth`): a turn that has not started by the deadline fails at its start.
 */
import type { Pool } from "pg";

import { loadInitiatorAuth } from "../../runtime/history/history-repository.js";
import { sessionAddress } from "../../runtime/session/channel-session.js";
import { TELEGRAM_CHANNEL_KIND } from "../../runtime/telegram/channel-types.js";
import { inJournalTransaction, type JournalDatabase } from "../../runtime/turn/journal-repository.js";
import { startTurnWithClient } from "../../runtime/turn/turn-start.js";
import { AppError } from "../app-error.js";
import type { PreparedConversationWakeup } from "./conversation-wakeup-preparation.js";
import type { ConversationWakeupClaim, conversationWakeupRepository } from "./conversation-wakeup-repository.js";
import { conversationWakeupAuth, conversationWakeupMessage } from "./conversation-wakeup-turn.js";

export const WAKEUP_SESSION_INACTIVE_CODE = "AGENT_CONVERSATION_WAKEUP_SESSION_INACTIVE";

export function createConversationWakeupTurn(input: {
  readonly admissionMilliseconds: number;
  readonly database: JournalDatabase & Pick<Pool, "query">;
  readonly now: () => Date;
  readonly repository: Pick<typeof conversationWakeupRepository, "bindDispatch">;
}) {
  return async function createTurn(claim: ConversationWakeupClaim, wakeup: PreparedConversationWakeup): Promise<string> {
    const now = input.now();
    const { context, message } = conversationWakeupMessage(wakeup, now);
    const dispatch = { admissionDeadlineAt: new Date(now.getTime() + input.admissionMilliseconds), id: crypto.randomUUID() };
    return await inJournalTransaction(input.database, async (client) => {
      const address = await sessionAddress(client, wakeup.agentSessionId);
      if (address === null || address.channelKind !== TELEGRAM_CHANNEL_KIND) {
        throw new AppError(WAKEUP_SESSION_INACTIVE_CODE, "Разговор пробуждения больше не ведётся");
      }
      const auth = conversationWakeupAuth(wakeup, now, { deadlineAt: dispatch.admissionDeadlineAt.toISOString(), id: dispatch.id });
      const turn = await startTurnWithClient(client, {
        auth: { current: auth, initiator: await loadInitiatorAuth(client, wakeup.agentSessionId) },
        channel: { continuationToken: address.token, kind: TELEGRAM_CHANNEL_KIND },
        input: { context, message },
        kind: "wakeup",
        parent: null,
        sessionId: wakeup.agentSessionId,
      });
      await input.repository.bindDispatch(client, claim, { ...dispatch, sessionId: wakeup.agentSessionId, turnId: turn.id });
      return turn.id;
    });
  };
}
