/**
 * Terminal transitions shared by every stage of a wake-up in its chat queue.
 *
 * Exports:
 * - `CONVERSATION_CHANGED_CODE`: the chat started another conversation; the wake-up is parked.
 * - `WAKEUP_NOT_STARTED_CODE`: the turn never started; the wake-up is parked.
 * - `WAKEUP_HANDOFF_FAILED_CODE`: Eve refused the handoff; the wake-up is parked.
 * - `WAKEUP_LEASE_LOST_CODE`: the queue item is no longer owned by this processor.
 * - `inTransaction`: runs one wake-up transition atomically.
 * - `closeWakeup`: makes the queue item terminal and frees its chat's lane.
 * - `withdrawUnstartedRun`: removes a run whose turn never started and parks its schedule.
 * - `failUnstartedRun`: fails a run whose turn will never start, together with its schedule.
 *
 * Key constructs:
 * - The lane mark on the queue row is removed by every terminal transition here. A removed run
 *   takes its queue item with it, and deleting the item clears the mark by its foreign key.
 * - A withdrawn run frees its occurrence: resuming the schedule runs the same due time again.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";

export const CONVERSATION_CHANGED_CODE = "AGENT_SCHEDULE_CONVERSATION_CHANGED";
export const WAKEUP_NOT_STARTED_CODE = "AGENT_CONVERSATION_WAKEUP_NOT_STARTED";
export const WAKEUP_HANDOFF_FAILED_CODE = "AGENT_CONVERSATION_WAKEUP_HANDOFF_FAILED";
// The item shares the chat's Telegram lane and its lease, so the ingress observer's code applies.
export const WAKEUP_LEASE_LOST_CODE = "AGENT_TELEGRAM_LEASE_LOST";

export function wakeupLeaseLost(): AppError {
  return new AppError(WAKEUP_LEASE_LOST_CODE, "Срок обработки пробуждения в очереди чата истёк");
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeWakeup(
  client: PoolClient,
  wakeupId: string,
  outcome: { status: "completed" } | { code: string; message: string; status: "failed" },
): Promise<void> {
  const failed = outcome.status === "failed";
  await client.query(
    `UPDATE telegram_ingress_wakeups
        SET status = $2, lease_token = NULL, lease_expires_at = NULL, last_error_code = $3,
            last_error_message = left($4, 1000), completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [wakeupId, outcome.status, failed ? outcome.code : null, failed ? outcome.message : null],
  );
  await client.query("UPDATE telegram_ingress_queues SET active_wakeup_id = NULL WHERE active_wakeup_id = $1", [wakeupId]);
}

/**
 * Returns false when the turn was admitted meanwhile: that turn now owns the run. The admission
 * of a later turn needs this run, so a turn that was still on its way can no longer start.
 */
export async function withdrawUnstartedRun(
  client: PoolClient,
  scheduleId: string,
  runId: string,
  code: string | null,
): Promise<boolean> {
  const removed = await client.query(
    `DELETE FROM agent_schedule_runs
      WHERE id = $1 AND recovery_protocol = 2 AND status IN ('dispatching', 'running') AND eve_turn_id IS NULL`,
    [runId],
  );
  if (removed.rowCount !== 1) return false;
  await client.query(
    `UPDATE agent_schedules
        SET status = 'paused', pause_requested = false, lease_token = NULL, lease_expires_at = NULL,
            dispatch_started_at = NULL, attempts = 0, last_error_code = $2, updated_at = now()
      WHERE id = $1 AND status = 'leased'`,
    [scheduleId, code],
  );
  if (code !== null) {
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       SELECT family_id, 'agent_schedule.conversation_paused', id, jsonb_build_object('code', $2::text)
         FROM agent_schedules WHERE id = $1`,
      [scheduleId, code],
    );
  }
  return true;
}

export async function failUnstartedRun(client: PoolClient, scheduleId: string, runId: string, code: string): Promise<void> {
  await client.query(
    `UPDATE agent_schedule_runs SET status = 'failed', error_code = $2, completed_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('dispatching', 'running')`,
    [runId, code],
  );
  await client.query(
    `UPDATE agent_schedules
        SET status = 'failed', pause_requested = false, lease_token = NULL, lease_expires_at = NULL,
            dispatch_started_at = NULL, last_error_code = $2, updated_at = now()
      WHERE id = $1 AND status = 'leased'`,
    [scheduleId, code],
  );
  await client.query(
    `INSERT INTO operational_incidents (operation_key, code, summary, context)
     VALUES ($1, 'AGENT_SCHEDULE_EXECUTION_FAILED',
             'Не удалось выполнить пробуждение в разговоре. Проверьте состояние сценария.',
             jsonb_build_object('scheduleId', $2::text, 'runId', $3::text, 'causeCode', $4::text))
     ON CONFLICT (operation_key) DO NOTHING`,
    [`schedule-run:${runId}`, scheduleId, runId, code],
  );
}
