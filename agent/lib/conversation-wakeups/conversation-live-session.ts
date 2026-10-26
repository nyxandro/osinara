/**
 * Whether the conversation a wake-up or a monitor belongs to is still the chat's live one.
 *
 * Export:
 * - `loadLiveConversationSession`: the live canonical session at the chat's route, if it is still
 *   the bound conversation; `null` when the chat moved on.
 *
 * A session that the next message will replace, because it failed or a rotation was requested,
 * counts as a changed conversation: what the wake-up or monitor was set up for is left behind.
 */
import type { PoolClient } from "pg";

export interface LiveConversationSession {
  agentSessionId: string;
  applicationSessionId: string;
  /** The conversation waits for a person's answer to an approval. */
  pendingOperation: boolean;
  /** The stable conversation thread that names the chat's sandbox. */
  sandboxSessionId: string;
}

export async function loadLiveConversationSession(
  client: PoolClient,
  route: { baseContinuationToken: string; conversationSessionId: string | null },
): Promise<LiveConversationSession | null> {
  const session = await client.query<{
    agent_session_id: string | null;
    id: string;
    pending_operation: boolean;
    rotation_requested: boolean;
    thread_id: string;
  }>(
    `SELECT session.id::text, session.thread_id::text, session.agent_session_id, session.pending_operation,
            session.rotation_requested_at IS NOT NULL AS rotation_requested
       FROM conversation_session_routes route
       JOIN conversation_sessions session ON session.id = route.session_id
      WHERE route.base_continuation_token = $1 AND session.retired_at IS NULL AND session.kind = 'canonical'
        AND session.id = $2::uuid`,
    [route.baseContinuationToken, route.conversationSessionId],
  );
  const live = session.rows[0];
  if (!live || live.agent_session_id === null || live.rotation_requested) return null;
  return {
    agentSessionId: live.agent_session_id,
    applicationSessionId: live.id,
    pendingOperation: live.pending_operation,
    sandboxSessionId: live.thread_id,
  };
}
