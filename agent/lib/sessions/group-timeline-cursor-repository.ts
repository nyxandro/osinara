/**
 * Durable per-session cursor into the unified application conversation timeline.
 *
 * Export:
 * - `groupTimelineCursorRepository`: reads and monotonically advances active group cursors.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  classifyMissedSessionEvent,
  type SessionEventResult,
} from "./session-event-order.js";

const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]*$/u;

function requireSequence(sequence: string): void {
  if (!POSITIVE_BIGINT_PATTERN.test(sequence)) {
    throw new AppError(
      "AGENT_TELEGRAM_TIMELINE_SEQUENCE_INVALID",
      "Не удалось определить позицию сообщения в истории группы",
    );
  }
}

export const groupTimelineCursorRepository = {
  async advance(
    applicationSessionId: string,
    agentSessionId: string,
    sequence: string,
  ): Promise<SessionEventResult> {
    requireSequence(sequence);
    const result = await database().query(
      `UPDATE conversation_sessions
          SET group_timeline_cursor = greatest(coalesce(group_timeline_cursor, 0), $3::bigint)
        WHERE id = $1
          AND eve_session_id = $2
           AND retired_at IS NULL`,
      [applicationSessionId, agentSessionId, sequence],
    );
    if (result.rowCount === 1) return "recorded";
    return await classifyMissedSessionEvent(
      applicationSessionId,
      agentSessionId,
      "AGENT_TELEGRAM_TIMELINE_CURSOR_UPDATE_FAILED",
      "Не удалось сохранить позицию истории группового разговора",
    );
  },

  async currentGroupTimelineCursor(applicationSessionId: string): Promise<string | null> {
    const result = await database().query<{ group_timeline_cursor: string | null }>(
      `SELECT group_timeline_cursor::text
         FROM conversation_sessions
         WHERE id = $1 AND retired_at IS NULL`,
      [applicationSessionId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(
        "AGENT_CONVERSATION_SESSION_NOT_ACTIVE",
        "Контекст разговора уже завершён",
      );
    }
    return row.group_timeline_cursor;
  },
};
