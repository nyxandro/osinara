/**
 * Monotonic Eve root event classification for application sessions.
 *
 * Exports:
 * - `SessionEventResult`: whether an Eve lifecycle event was recorded or arrived stale.
 * - `classifyMissedSessionEvent`: distinguishes stale roots from invalid session state.
 * - `isCurrentEveSession`: verifies that delivery belongs to the active application generation.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export type SessionEventResult = "recorded" | "stale";

export async function isCurrentEveSession(id: string, eveSessionId: string): Promise<boolean> {
  const result = await database().query(
    `SELECT 1 FROM conversation_sessions
      WHERE id = $1 AND retired_at IS NULL AND eve_session_id = $2`,
    [id, eveSessionId],
  );
  return result.rowCount === 1;
}

export async function classifyMissedSessionEvent(
  id: string,
  eveSessionId: string,
  code: string,
  message: string,
): Promise<SessionEventResult> {
  const active = await database().query<{ eve_session_id: string | null }>(
    "SELECT eve_session_id FROM conversation_sessions WHERE id = $1 AND retired_at IS NULL",
    [id],
  );
  const current = active.rows[0];
  if (current?.eve_session_id && current.eve_session_id > eveSessionId) return "stale";
  throw new AppError(code, message);
}
