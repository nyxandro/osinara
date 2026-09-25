/**
 * PostgreSQL persistence for Eve session lifecycle events.
 *
 * Export:
 * - `sessionLifecycleEventRepository`: Eve binding, completion/failure, and rotation requests.
 */
import type { PoolClient } from "pg";

import { SESSION_RETENTION_DAYS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { classifyMissedSessionEvent, type SessionEventResult } from "./session-eve-event.js";

async function finalizeRetirement(client: PoolClient, id: string): Promise<void> {
  // Route removal and the audit record are part of the same commit as the terminal state change.
  await client.query(
    `DELETE FROM conversation_session_routes route
      WHERE route.session_id = $1
        AND EXISTS (
          SELECT 1 FROM conversation_sessions session
           WHERE session.id = route.session_id AND session.retired_at IS NOT NULL
        )`,
    [id],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
     SELECT family_id, 'session.noncanonical_retired', id,
            jsonb_build_object('kind', kind::text, 'taskState', task_state::text)
       FROM conversation_sessions
      WHERE id = $1 AND retired_at IS NOT NULL AND kind <> 'canonical'`,
    [id],
  );
}

async function applyTerminalMutation(input: {
  id: string;
  parameters: readonly unknown[];
  sql: string;
}): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(input.sql, [...input.parameters]);
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await finalizeRetirement(client, input.id);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveFailureSessionForUpdate(
  client: PoolClient,
  continuationToken: string,
): Promise<string> {
  // Eve's exact current continuation is authoritative over a stale alias with the same text.
  const exact = await client.query<{ id: string }>(
    `SELECT id FROM conversation_sessions
      WHERE retired_at IS NULL AND continuation_token = $1
      FOR UPDATE`,
    [continuationToken],
  );
  if (exact.rowCount === 1) return exact.rows[0]!.id;

  const route = await client.query<{ id: string }>(
    `SELECT session.id
       FROM conversation_session_routes route
       JOIN conversation_sessions session ON session.id = route.session_id
      WHERE route.base_continuation_token = $1 AND session.retired_at IS NULL
      FOR UPDATE OF session`,
    [continuationToken],
  );
  if (route.rowCount === 1) return route.rows[0]!.id;
  throw new AppError(
    "AGENT_SESSION_FAILURE_RECORD_FAILED",
    route.rowCount === 0
      ? "Не удалось завершить повреждённый контекст"
      : "Маршрут повреждённого контекста связан с несколькими сессиями",
  );
}

export const sessionLifecycleEventRepository = {
  async retireUnstartedScheduledSession(id: string): Promise<void> {
    const retired = await applyTerminalMutation({
      id,
      sql:
      `UPDATE conversation_sessions
          SET pending_operation = false, task_state = 'failed', retired_at = now(),
              delete_after = now() + $2 * interval '1 day'
        WHERE id = $1 AND retired_at IS NULL AND kind = 'scheduled'
          AND eve_session_id IS NULL`,
      parameters: [id, SESSION_RETENTION_DAYS],
    });
    if (!retired) {
      throw new AppError(
        "AGENT_SCHEDULE_SESSION_RETIRE_FAILED",
        "Не удалось закрыть незапущенный контекст автоматизации",
      );
    }
  },

  async hasPendingOperation(id: string, eveSessionId: string): Promise<boolean> {
    const result = await database().query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM conversation_sessions
          WHERE id = $1 AND eve_session_id = $2
            AND pending_operation = true AND retired_at IS NULL
       ) AS pending`,
      [id, eveSessionId],
    );
    return result.rows[0]?.pending === true;
  },

  async bindEveSession(id: string, eveSessionId: string): Promise<SessionEventResult> {
    const result = await database().query(
      `UPDATE conversation_sessions
           SET eve_session_id = $2
         WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      [id, eveSessionId],
    );
    if (result.rowCount === 1) return "recorded";
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_BIND_FAILED",
      "Не удалось связать текущий контекст с Eve",
    );
  },

  async markPendingOperation(id: string, pending: boolean): Promise<void> {
    const result = await database().query(
      "UPDATE conversation_sessions SET pending_operation = $2 WHERE id = $1 AND retired_at IS NULL",
      [id, pending],
    );
    if (result.rowCount === 1) return;
    throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
  },

  async resumePendingSession(id: string, eveSessionId: string): Promise<void> {
    const result = await database().query(
      `UPDATE conversation_sessions
          SET pending_operation = false,
              pending_request_id = NULL,
              task_state = CASE
                WHEN kind <> 'canonical' THEN 'running'::conversation_task_state
                ELSE task_state
              END
        WHERE id = $1 AND eve_session_id = $2 AND retired_at IS NULL`,
      [id, eveSessionId],
    );
    if (result.rowCount !== 1) {
      throw new AppError(
        "AGENT_SESSION_RESUME_STATE_FAILED",
        "Не удалось обновить состояние продолжаемого действия",
      );
    }
  },

  async recordTurnCompleted(
    id: string,
    eveSessionId: string,
    pendingOperation: boolean,
    /** A wake-up turn answers no person, so it does not spend the conversation's turn budget. */
    countsTowardRotation: boolean,
  ): Promise<SessionEventResult> {
    const recorded = await applyTerminalMutation({
      id,
      sql:
      `UPDATE conversation_sessions
          SET completed_turns = completed_turns + CASE WHEN $5 THEN 1 ELSE 0 END,
              last_activity_at = now(), pending_operation = $3,
              eve_session_id = $2,
              task_state = CASE
                WHEN kind <> 'canonical' AND $3 THEN 'pending'::conversation_task_state
                WHEN kind <> 'canonical' THEN 'completed'::conversation_task_state
                ELSE task_state
              END,
              retired_at = CASE WHEN kind <> 'canonical' AND NOT $3 THEN now() ELSE retired_at END,
              delete_after = CASE
                WHEN kind <> 'canonical' AND NOT $3 THEN now() + $4 * interval '1 day'
                ELSE delete_after
              END
        WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      parameters: [id, eveSessionId, pendingOperation, SESSION_RETENTION_DAYS, countsTowardRotation],
    });
    if (recorded) return "recorded";
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_TURN_RECORD_FAILED",
      "Не удалось сохранить завершённый ход",
    );
  },

  async recordTurnFailed(id: string, eveSessionId: string): Promise<SessionEventResult> {
    const recorded = await applyTerminalMutation({
      id,
      sql:
      `UPDATE conversation_sessions
          SET pending_operation = false, eve_session_id = $2,
              task_state = CASE
                WHEN kind <> 'canonical' THEN 'failed'::conversation_task_state
                ELSE task_state
              END,
              retired_at = CASE WHEN kind <> 'canonical' THEN now() ELSE retired_at END,
              delete_after = CASE
                WHEN kind <> 'canonical' THEN now() + $3 * interval '1 day'
                ELSE delete_after
              END
        WHERE id = $1 AND retired_at IS NULL
           AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
      parameters: [id, eveSessionId, SESSION_RETENTION_DAYS],
    });
    if (recorded) return "recorded";
    return await classifyMissedSessionEvent(
      id,
      eveSessionId,
      "AGENT_SESSION_FAILURE_RECORD_FAILED",
      "Не удалось сохранить состояние контекста",
    );
  },

  async recordSessionFailedByContinuationToken(
    continuationToken: string,
    eveSessionId: string,
  ): Promise<SessionEventResult> {
    const client = await database().connect();
    let id: string;
    let recorded = false;
    try {
      await client.query("BEGIN");
      id = await resolveFailureSessionForUpdate(client, continuationToken);
      const result = await client.query(
        `UPDATE conversation_sessions
             SET pending_operation = false,
                 rotation_requested_at = CASE WHEN kind = 'canonical' THEN now() ELSE rotation_requested_at END,
                 eve_session_id = $2,
                 task_state = CASE WHEN kind <> 'canonical' THEN 'failed'::conversation_task_state ELSE task_state END,
                 retired_at = CASE WHEN kind <> 'canonical' THEN now() ELSE retired_at END,
                 delete_after = CASE
                   WHEN kind <> 'canonical' THEN now() + $3 * interval '1 day'
                   ELSE delete_after
                 END
          WHERE id = $1 AND retired_at IS NULL
            AND (eve_session_id IS NULL OR eve_session_id <= $2)`,
        [id, eveSessionId, SESSION_RETENTION_DAYS],
      );
      if (result.rowCount === 1) {
        await finalizeRetirement(client, id);
        await client.query("COMMIT");
        recorded = true;
      } else {
        await client.query("ROLLBACK");
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (recorded) return "recorded";
    return await classifyMissedSessionEvent(
      id!,
      eveSessionId,
      "AGENT_SESSION_FAILURE_RECORD_FAILED",
      "Не удалось сохранить состояние повреждённого контекста",
    );
  },

  async requestRotation(id: string): Promise<void> {
    const result = await database().query(
      "UPDATE conversation_sessions SET rotation_requested_at = now() WHERE id = $1 AND retired_at IS NULL",
      [id],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
    }
  },
};
