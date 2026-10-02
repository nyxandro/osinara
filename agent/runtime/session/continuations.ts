/**
 * Conversation addresses: which runtime session a channel address belongs to.
 *
 * Exports:
 * - `findContinuation`: the session of an address, or `null` when the address is new.
 * - `bindContinuation`: gives an address to a session; the first binding of an address wins.
 * - `loadChannelState`, `saveChannelState`: the channel's JSON state of a session.
 *
 * Eve kept the same mapping in its continuation hooks and the state in its channel context;
 * imported sessions carry both over (`history/import-eve-history.ts`).
 */
import type { Pool } from "pg";

import { AppError } from "../../lib/app-error.js";

type ContinuationClient = Pick<Pool, "query">;

export async function findContinuation(client: ContinuationClient, address: { channelKind: string; token: string }): Promise<string | null> {
  const row = (await client.query<{ session_id: string }>(
    "SELECT session_id FROM agent_continuations WHERE channel_kind = $1 AND token = $2",
    [address.channelKind, address.token],
  )).rows[0];
  return row?.session_id ?? null;
}

/** Returns the session that owns the address after the call: this one, or an earlier binding's. */
export async function bindContinuation(client: ContinuationClient, input: { channelKind: string; sessionId: string; token: string }): Promise<string> {
  const row = (await client.query<{ session_id: string }>(
    `INSERT INTO agent_continuations (channel_kind, token, session_id) VALUES ($1, $2, $3)
     ON CONFLICT (channel_kind, token) DO UPDATE SET channel_kind = EXCLUDED.channel_kind
     RETURNING session_id`,
    [input.channelKind, input.token, input.sessionId],
  )).rows[0]!;
  return row.session_id;
}

export async function loadChannelState<TState>(client: ContinuationClient, sessionId: string): Promise<TState | null> {
  const row = (await client.query<{ channel_state: TState | null }>(
    "SELECT channel_state FROM agent_session_state WHERE session_id = $1", [sessionId],
  )).rows[0];
  if (!row) throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
  return row.channel_state;
}

export async function saveChannelState(client: ContinuationClient, sessionId: string, state: object): Promise<void> {
  const updated = await client.query(
    "UPDATE agent_session_state SET channel_state = $2::json, updated_at = now() WHERE session_id = $1",
    [sessionId, JSON.stringify(state)],
  );
  if (updated.rowCount !== 1) throw new AppError("AGENT_SESSION_HISTORY_MISSING", "История разговора не найдена", { details: { sessionId } });
}
