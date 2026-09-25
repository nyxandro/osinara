/**
 * Run lifecycle of a wake-up turn inside its chat's own conversation.
 *
 * Export:
 * - `conversationWakeupRunRepository`: binds the Eve turn to its run and closes the run when that
 *   turn completes, fails, or is cancelled.
 *
 * The run is closed by the same completion logic as every scheduled run: it counts the execution,
 * applies the run limit, and schedules the next occurrence. A turn that delivered a message counts
 * as delivered, a turn that stayed silent as silent, and silence after a delivery that may have
 * started is a failure, because the two cannot be told apart. Only the run's own admitted turn
 * closes it; a turn refused before admission never reached the model, so its wake-up is parked.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { finishActiveAgentScheduleRun } from "../agent-schedules/agent-schedule-run-completion.js";
import { inTransaction, WAKEUP_NOT_STARTED_CODE, withdrawUnstartedRun } from "./conversation-wakeup-transitions.js";

interface WakeupTurn {
  applicationSessionId: string;
  eveSessionId: string;
  eveTurnId: string;
  runId: string;
}

export const conversationWakeupRunRepository = {
  async admitTurn(turn: WakeupTurn): Promise<void> {
    const result = await database().query(
      `UPDATE agent_schedule_runs SET eve_turn_id = $4, updated_at = now()
        WHERE id = $1 AND application_session_id = $2 AND eve_session_id = $3 AND status = 'running'
          AND recovery_protocol = 2 AND (eve_turn_id IS NULL OR eve_turn_id = $4)`,
      [turn.runId, turn.applicationSessionId, turn.eveSessionId, turn.eveTurnId],
    );
    if (result.rowCount !== 1) {
      throw new AppError("AGENT_SCHEDULE_ATTEMPT_STALE", "Попытка запуска расписания уже закрыта");
    }
  },

  /** Returns false when the run was already closed, which a replayed terminal event may observe. */
  async finishTurn(turn: WakeupTurn & { completedAt: Date; failureCode: string | null }): Promise<boolean> {
    return await inTransaction(async (client) => {
      const run = await client.query<{ eve_turn_id: string | null; schedule_id: string }>(
        `SELECT eve_turn_id, schedule_id::text FROM agent_schedule_runs
          WHERE id = $1 AND application_session_id = $2 AND eve_session_id = $3 AND recovery_protocol = 2
            AND status = 'running'
          FOR UPDATE`,
        [turn.runId, turn.applicationSessionId, turn.eveSessionId],
      );
      const row = run.rows[0];
      if (!row) return false;
      if (row.eve_turn_id === null) {
        return await withdrawUnstartedRun(client, row.schedule_id, turn.runId, WAKEUP_NOT_STARTED_CODE);
      }
      if (row.eve_turn_id !== turn.eveTurnId) return false;
      const delivered = await client.query<{ delivered: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM telegram_final_deliveries
            WHERE application_session_id = $1 AND eve_session_id = $2 AND eve_turn_id = $3
              AND status = 'delivered') AS delivered`,
        [turn.applicationSessionId, turn.eveSessionId, turn.eveTurnId],
      );
      return await finishActiveAgentScheduleRun(client, {
        applicationSessionId: turn.applicationSessionId,
        completedAt: turn.completedAt,
        eveSessionId: turn.eveSessionId,
        outcome: turn.failureCode !== null
          ? { errorCode: turn.failureCode, kind: "failed" }
          : delivered.rows[0]?.delivered ? { kind: "delivered" } : { kind: "silent" },
        runId: turn.runId,
      });
    });
  },
};
