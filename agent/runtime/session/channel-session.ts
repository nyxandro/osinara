/**
 * The session of a channel address, and a turn started in it.
 *
 * Exports:
 * - `openChannelSession`: the session of an address; a new address gets a new session, opened by
 *   the given auth, with the channel's initial state. Later deliveries keep the stored state.
 * - `startChannelTurn`: opens the address's session and creates a turn in it, in one transaction;
 *   the caller runs the turn.
 * - `sessionAddress`: the address a session was opened under, for turns that start inside it.
 *
 * Eve kept the same rule in its channel addresses (`createChannelAddress`): only a delivery with a
 * message may create a session, and the state passed with it applies only then.
 */
import { AppError } from "../../lib/app-error.js";
import type { SessionAuthContext } from "../context.js";
import { createSessionHistory, loadInitiatorAuth, type HistoryClient } from "../history/history-repository.js";
import { newSessionId } from "../ids.js";
import { inJournalTransaction, type JournalDatabase } from "../turn/journal-repository.js";
import { startTurnWithClient } from "../turn/turn-start.js";
import type { TurnChannel, TurnKind, TurnStartInput } from "../turn/turn-types.js";
import { bindContinuation, findContinuation } from "./continuations.js";

export async function openChannelSession(client: HistoryClient, input: {
  readonly auth: SessionAuthContext;
  readonly channelKind: string;
  readonly channelState: Record<string, unknown> | null;
  readonly token: string;
}): Promise<string> {
  // One transaction per address at a time: two first deliveries must not open two sessions.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${input.channelKind}:${input.token}`]);
  const existing = await findContinuation(client, { channelKind: input.channelKind, token: input.token });
  if (existing !== null) return existing;
  const applicationSessionId = input.auth.attributes.applicationSessionId;
  if (typeof applicationSessionId !== "string") {
    throw new AppError("AGENT_SESSION_CONTEXT_INVALID", "Не удалось определить текущий контекст разговора");
  }
  const sessionId = newSessionId();
  await createSessionHistory(client, {
    announcedSkills: null,
    applicationSessionId,
    channelState: input.channelState === null ? null : { ...input.channelState },
    compaction: { inputTokens: null, promptMessageCount: null },
    history: [],
    initiatorAuth: input.auth,
    parentSessionId: null,
    sandbox: null,
    sessionId,
    source: "runtime",
    todo: null,
  });
  await bindContinuation(client, { channelKind: input.channelKind, sessionId, token: input.token });
  return sessionId;
}

export async function startChannelTurn(database: JournalDatabase, input: {
  readonly auth: SessionAuthContext;
  readonly channel: Omit<TurnChannel, "continuationToken">;
  readonly channelState: Record<string, unknown> | null;
  readonly input: TurnStartInput;
  readonly kind: TurnKind;
  readonly token: string;
}): Promise<{ readonly sessionId: string; readonly turnId: string }> {
  return await inJournalTransaction(database, async (client) => {
    const sessionId = await openChannelSession(client, {
      auth: input.auth, channelKind: input.channel.kind, channelState: input.channelState, token: input.token,
    });
    const turn = await startTurnWithClient(client, {
      auth: { current: input.auth, initiator: await loadInitiatorAuth(client, sessionId) },
      channel: { ...input.channel, continuationToken: input.token },
      input: input.input,
      kind: input.kind,
      parent: null,
      sessionId,
    });
    return { sessionId, turnId: turn.id };
  });
}

/** The first address bound to the session, or `null` for a session no channel opened. */
export async function sessionAddress(client: HistoryClient, sessionId: string): Promise<{ channelKind: string; token: string } | null> {
  const row = (await client.query<{ channel_kind: string; token: string }>(
    "SELECT channel_kind, token FROM agent_continuations WHERE session_id = $1 ORDER BY created_at, token LIMIT 1",
    [sessionId],
  )).rows[0];
  return row === undefined ? null : { channelKind: row.channel_kind, token: row.token };
}
