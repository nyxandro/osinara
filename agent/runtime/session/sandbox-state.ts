/**
 * The sandbox a session opened first: its container identity, mounts and access.
 *
 * Exports:
 * - `loadSandboxState`: the stored metadata, or `null` before the session's first sandbox use.
 * - `saveFirstSandboxState`: records it once; a later open is checked against it.
 *
 * The shape is the runner backend's (`runner-sandbox-state.ts`); imported sessions carry Eve's.
 */
import type { Pool } from "pg";

import { AppError } from "../../lib/app-error.js";

type StateClient = Pick<Pool, "query">;

export async function loadSandboxState(client: StateClient, sessionId: string): Promise<Record<string, unknown> | null> {
  const row = (await client.query<{ sandbox_state: Record<string, unknown> | null }>(
    "SELECT sandbox_state FROM agent_session_state WHERE session_id = $1", [sessionId],
  )).rows[0];
  if (!row) throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
  return row.sandbox_state;
}

/** Concurrent first opens agree: only the first write lands, the caller re-reads on a lost race. */
export async function saveFirstSandboxState(client: StateClient, sessionId: string, state: object): Promise<boolean> {
  const updated = await client.query(
    "UPDATE agent_session_state SET sandbox_state = $2::json, updated_at = now() WHERE session_id = $1 AND sandbox_state IS NULL",
    [sessionId, JSON.stringify(state)],
  );
  return updated.rowCount === 1;
}
