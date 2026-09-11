/**
 * Atomic Telegram ingress completion and Eve event-stream cursor persistence.
 *
 * Exports:
 * - `telegramIngressSessionCursorRepository`: monotonic startIndex read/complete operations.
 */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { settleTelegramMediaGroupMembersSql } from "./telegram-media-group-repository.js";
import {
  requireNonEmpty,
  requireUpdateId,
  requireUuid,
} from "./telegram-ingress-contract.js";

export const telegramIngressSessionCursorRepository = {
  async completeWithSession(
    updateId: string,
    leaseToken: string,
    sessionId: string,
    nextEventIndex: number,
  ): Promise<void> {
    requireNonEmpty(sessionId, "AGENT_TELEGRAM_SESSION_INVALID", "Eve не вернул идентификатор сессии");
    if (!Number.isSafeInteger(nextEventIndex) || nextEventIndex < 0) {
      throw new AppError(
        "AGENT_TELEGRAM_SESSION_CURSOR_INVALID",
        "Eve вернул некорректную позицию потока событий сессии",
      );
    }
    requireUpdateId(updateId);
    requireUuid(
      leaseToken,
      "AGENT_TELEGRAM_LEASE_INVALID",
      "Токен аренды обработки Telegram имеет некорректный формат",
    );
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH finished AS (
           UPDATE telegram_ingress_updates
           SET status = 'completed', eve_session_id = $3, completed_at = now(),
               lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE update_id = $1 AND status = 'processing' AND lease_token = $2
             AND lease_expires_at > now()
           RETURNING *
         ), ${settleTelegramMediaGroupMembersSql} SELECT update_id FROM finished`,
        [updateId, leaseToken, sessionId],
      );
      if (!result.rowCount) {
        throw new AppError("AGENT_TELEGRAM_LEASE_LOST", "Срок обработки сообщения Telegram истёк");
      }
      const cursor = await client.query(
        `INSERT INTO eve_session_event_cursors (eve_session_id, next_event_index)
         VALUES ($1, $2)
         ON CONFLICT (eve_session_id) DO UPDATE
         SET next_event_index = EXCLUDED.next_event_index, updated_at = now()
         WHERE eve_session_event_cursors.next_event_index <= EXCLUDED.next_event_index`,
        [sessionId, nextEventIndex],
      );
      if (!cursor.rowCount) {
        throw new AppError(
          "AGENT_TELEGRAM_SESSION_CURSOR_REGRESSION",
          "Позиция потока событий Eve не может двигаться назад",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async sessionEventStreamCursor(sessionId: string): Promise<number> {
    requireNonEmpty(sessionId, "AGENT_TELEGRAM_SESSION_INVALID", "Eve не вернул идентификатор сессии");
    const result = await database().query<{ next_event_index: string }>(
      "SELECT next_event_index::text FROM eve_session_event_cursors WHERE eve_session_id = $1",
      [sessionId],
    );
    const value = result.rows[0]?.next_event_index;
    if (value === undefined) return 0;
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new AppError(
        "AGENT_TELEGRAM_SESSION_CURSOR_INVALID",
        "Сохранённая позиция потока событий Eve повреждена",
      );
    }
    return cursor;
  },
};
