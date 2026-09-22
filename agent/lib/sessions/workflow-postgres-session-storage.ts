/**
 * PostgreSQL Workflow physical session retention adapter.
 *
 * Exports:
 * - `deletePostgresEveSession`: atomically deletes one verified terminal run via a query client.
 * - `deleteConfiguredPostgresEveSession`: fail-fast environment boundary for scheduled retention.
 *
 * Invariants:
 * - Table names come from the pinned package's public exported schema.
 * - The run row is locked and removed last; any failure rolls the transaction back.
 * - Existing hooks block deletion so Workflow token-retention semantics cannot be shortened.
 */
import { EVE_RUN_ABANDONED_AFTER_HOURS } from "../../config.js";
import { createApplicationDatabasePool } from "../database-client.js";

import { AppError } from "../app-error.js";

const EVE_RUN_ID_PATTERN = /^wrun_[A-Z0-9]{26}$/u;
const TERMINAL_RUN_STATUSES = new Set(["cancelled", "completed", "failed"]);

/** Read-only proof used by the explicit operator recovery, without re-enqueuing a Workflow run. */
export async function isConfiguredEveSessionTerminal(runId: string): Promise<boolean> {
  const status = await readConfiguredEveRunStatus(runId);
  return status !== null && TERMINAL_RUN_STATUSES.has(status);
}

export async function readConfiguredEveRunStatus(runId: string): Promise<string | null> {
  if (!EVE_RUN_ID_PATTERN.test(runId)) throw new AppError("AGENT_EVE_SESSION_ID_INVALID", "Некорректный идентификатор Eve-сессии");
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) throw new AppError("AGENT_WORKFLOW_DATABASE_CONFIG_MISSING", "Не задано подключение к базе Workflow");
  const client = createApplicationDatabasePool({ connectionString,max: 1,connectionTimeoutMillis: 5000 });
  try {
    const result = await client.query<{ status: string }>("SELECT status::text FROM workflow.workflow_runs WHERE id = $1", [runId]);
    const status = result.rows[0]?.status;
    return status ?? null;
  } finally { await client.end(); }
}

interface WorkflowQueryClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

export async function deletePostgresEveSession(
  runId: string,
  client: WorkflowQueryClient,
): Promise<void> {
  if (!EVE_RUN_ID_PATTERN.test(runId)) {
    throw new AppError(
      "AGENT_EVE_SESSION_ID_INVALID",
      "Идентификатор удаляемой Eve-сессии некорректен",
    );
  }

  await client.query("BEGIN");
  try {
    // Lock the primary row before proving that application retirement cannot race active Workflow.
    // Abandonment is decided by PostgreSQL against its own clock; the timestamps carry no zone.
    //
    // Activity is the run's own event stream, not `workflow_runs.updated_at`: that column moves on
    // creation, start, terminal transition and attribute writes, so a live run can keep it weeks
    // old while working. A run whose newest event is a day old is not working.
    const run = await client.query(
      `SELECT run.status::text AS status,
              COALESCE(
                (SELECT max(event.created_at) FROM workflow.workflow_events AS event
                  WHERE event.run_id = run.id),
                run.updated_at
              ) < (now() AT TIME ZONE 'UTC') - ($2 || ' hours')::interval AS abandoned
         FROM workflow.workflow_runs AS run WHERE run.id = $1 FOR UPDATE OF run`,
      [runId, String(EVE_RUN_ABANDONED_AFTER_HOURS)],
    );
    const status = run.rows[0]?.status;
    if (typeof status !== "string") {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_MISSING",
        `Не найдены данные удаляемой Eve-сессии ${runId}`,
      );
    }
    const abandoned = run.rows[0]?.abandoned === true;
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      // The guard exists to protect a scenario that is still working. A run with no event for a
      // day is not one: it never reached a terminal status and nothing will move it there.
      if (!abandoned) {
        throw new AppError(
          "AGENT_EVE_SESSION_STORAGE_ACTIVE",
          `Eve-сессия ${runId} ещё выполняется и не может быть удалена`,
        );
      }
      console.warn(JSON.stringify({
        code: "AGENT_EVE_SESSION_ABANDONED_RUN_DELETED", runId, status,
        abandonedAfterHours: EVE_RUN_ABANDONED_AFTER_HOURS,
      }));
    }

    // Hooks carry externally reusable tokens; only Workflow may end their retention window — and
    // it does, at the terminal transition: on production not one completed run holds a hook while
    // every stuck one does. An abandoned run never reaches that transition, so its hooks would
    // outlive it forever and this deletion would refuse the session for good. They go with it.
    if (!abandoned) {
      const hook = await client.query(
        "SELECT EXISTS (SELECT 1 FROM workflow.workflow_hooks WHERE run_id = $1) AS exists",
        [runId],
      );
      if (hook.rows[0]?.exists === true) {
        throw new AppError(
          "AGENT_EVE_SESSION_HOOK_RETENTION_ACTIVE",
          `Eve-сессия ${runId} ещё содержит защищённые Workflow hooks`,
        );
      }
    }

    // Public schema has no foreign keys, so remove every per-run projection before the run itself.
    for (const statement of [
      "DELETE FROM workflow.workflow_stream_chunks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_waits WHERE run_id = $1",
      "DELETE FROM workflow.workflow_hooks WHERE run_id = $1",
      "DELETE FROM workflow.workflow_steps WHERE run_id = $1",
      "DELETE FROM workflow.workflow_events WHERE run_id = $1",
      "DELETE FROM workflow.workflow_event_slots WHERE run_id = $1",
    ]) {
      await client.query(statement, [runId]);
    }
    const deletedRun = await client.query(
      "DELETE FROM workflow.workflow_runs WHERE id = $1",
      [runId],
    );
    if (deletedRun.rowCount !== 1) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_DELETE_INCOMPLETE",
        `Не удалось удалить данные Eve-сессии ${runId}`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function deleteConfiguredPostgresEveSession(runId: string): Promise<void> {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) {
    throw new AppError(
      "AGENT_WORKFLOW_DATABASE_CONFIG_MISSING",
      "Не задано подключение к базе Workflow",
    );
  }

  // A short-lived client keeps the retention job independent from the world worker's pool lifecycle.
  const pool = createApplicationDatabasePool({ connectionString,max: 1,connectionTimeoutMillis: 5000 });
  try {
    const client=await pool.connect();
    try { await deletePostgresEveSession(runId,client); }
    finally { client.release(); }
  } finally {
    await pool.end();
  }
}
