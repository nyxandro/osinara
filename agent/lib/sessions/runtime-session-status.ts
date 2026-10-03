/**
 * What the runtime journal says about a session, for application bookkeeping that waits on it.
 *
 * Exports:
 * - `runtimeTurnStatus`: the status of one turn of a session, or `null` when the journal has none.
 * - `isRuntimeSessionIdle`: nothing runs or waits in the session or its child sessions any more.
 *
 * Replaces the reads of Eve's Workflow database (`workflow-turn-outcome.ts`,
 * `workflow-postgres-session-storage.ts`): turns now live in `agent_turns`.
 */
import type { TurnStatus } from "../../runtime/turn/turn-types.js";
import { database } from "../database.js";

export async function runtimeTurnStatus(sessionId: string, turnId: string): Promise<TurnStatus | null> {
  const row = (await database().query<{ status: TurnStatus }>(
    "SELECT status FROM agent_turns WHERE id = $1 AND session_id = $2",
    [turnId, sessionId],
  )).rows[0];
  return row?.status ?? null;
}

export async function isRuntimeSessionIdle(sessionId: string): Promise<boolean> {
  const row = (await database().query<{ busy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agent_turns turn JOIN agent_session_state state ON state.session_id = turn.session_id
        WHERE (state.session_id = $1 OR state.parent_session_id = $1) AND turn.status IN ('running', 'waiting_input')
     ) AS busy`,
    [sessionId],
  )).rows[0]!;
  return !row.busy;
}
