/**
 * An answer to a session's waiting request that arrives outside a channel, such as a timeout.
 *
 * Export:
 * - `respondInSession`: records the answers as `who` answered; when they release the parked step,
 *   its continuation turn starts in the background. Returns `stale` when nothing in the session
 *   waits for these requests any more.
 */
import type { Pool } from "pg";

import type { SessionAuthContext } from "./context.js";
import type { TurnDispatcher } from "./dispatch.js";
import { loadInitiatorAuth } from "./history/history-repository.js";
import type { InputResponse } from "./hitl/types.js";
import { inJournalTransaction, type JournalDatabase } from "./turn/journal-repository.js";
import { respondWithClient } from "./turn/turn-start.js";

export async function respondInSession(
  runtime: { readonly database: JournalDatabase & Pick<Pool, "query">; readonly dispatcher: Pick<TurnDispatcher, "start"> },
  input: {
    readonly auth: SessionAuthContext;
    readonly context: readonly string[];
    readonly responses: readonly InputResponse[];
    readonly sessionId: string;
  },
): Promise<"continued" | "recorded" | "stale"> {
  const outcome = await inJournalTransaction(runtime.database, async (client) => await respondWithClient(client, {
    auth: { current: input.auth, initiator: await loadInitiatorAuth(client, input.sessionId) },
    context: input.context,
    responses: input.responses,
    sessionId: input.sessionId,
  }));
  if (outcome.status === "resumed") {
    runtime.dispatcher.start(outcome.continuation.id);
    return "continued";
  }
  return outcome.status === "waiting" ? "recorded" : "stale";
}
