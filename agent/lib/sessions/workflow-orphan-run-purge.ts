/**
 * Purge of Workflow runs left behind by sessions the application already deleted.
 *
 * Exports:
 * - `purgeOrphanedWorkflowRuns`: removes up to one batch of orphaned runs via a query client.
 * - `purgeConfiguredOrphanedWorkflowRuns`: fail-fast environment boundary for the minute schedule.
 *
 * Eve starts every turn, subagent and session timer as its own run and records the session's root
 * run in the `$rootRunId` attribute. Session retention deletes that root and nothing else, so the
 * rest stayed forever. A run whose root is gone belongs to a session nobody can continue: the
 * conversation history lives in the root, and a new message starts a new session.
 *
 * Invariants:
 * - Only a finished run goes, and only after WORKFLOW_ORPHAN_RUN_PURGE_AFTER_HOURS.
 * - A session root is never touched here; it has no `$rootRunId` pointing elsewhere.
 * - A run holding hooks stays: only Workflow may end their retention window.
 * - Each run is re-checked under its row lock and removed in its own transaction.
 */
import {
  WORKFLOW_ORPHAN_RUN_PURGE_AFTER_HOURS,
  WORKFLOW_ORPHAN_RUN_PURGE_BATCH,
  WORKFLOW_ORPHAN_RUNS_PURGED_CODE,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { createApplicationDatabasePool } from "../database-client.js";
import { deleteWorkflowRunRows, type WorkflowQueryClient } from "./workflow-postgres-session-storage.js";

// `$1` is the age in hours. Timestamps carry no zone, so PostgreSQL compares on its own UTC clock.
const ORPHAN_CONDITION = `
  run.status IN ('completed', 'failed', 'cancelled')
  AND COALESCE(run.completed_at, run.updated_at)
      < (now() AT TIME ZONE 'UTC') - ($1 || ' hours')::interval
  AND run.attributes ? '$rootRunId'
  AND run.attributes->>'$rootRunId' <> run.id
  AND NOT EXISTS (SELECT 1 FROM workflow.workflow_runs AS root
                   WHERE root.id = run.attributes->>'$rootRunId')
  AND NOT EXISTS (SELECT 1 FROM workflow.workflow_hooks AS hook WHERE hook.run_id = run.id)`;

export async function purgeOrphanedWorkflowRuns(
  client: WorkflowQueryClient,
  batchSize: number,
): Promise<number> {
  const age = String(WORKFLOW_ORPHAN_RUN_PURGE_AFTER_HOURS);
  const candidates = await client.query(
    `SELECT run.id FROM workflow.workflow_runs AS run WHERE ${ORPHAN_CONDITION}
      ORDER BY run.created_at LIMIT $2`,
    [age, batchSize],
  );

  let purged = 0;
  for (const row of candidates.rows) {
    const runId = row.id;
    if (typeof runId !== "string") {
      throw new AppError("AGENT_WORKFLOW_ORPHAN_RUN_ID_INVALID", "Некорректный идентификатор запуска Workflow");
    }
    await client.query("BEGIN");
    try {
      // The list was read without locks; whatever changed since is decided again under the lock.
      const locked = await client.query(
        `SELECT run.id FROM workflow.workflow_runs AS run
          WHERE run.id = $2 AND ${ORPHAN_CONDITION} FOR UPDATE OF run`,
        [age, runId],
      );
      if (locked.rowCount !== 1) {
        await client.query("ROLLBACK");
        continue;
      }
      await deleteWorkflowRunRows(runId, client);
      await client.query("COMMIT");
      purged += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return purged;
}

export async function purgeConfiguredOrphanedWorkflowRuns(): Promise<number> {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) {
    throw new AppError(
      "AGENT_WORKFLOW_DATABASE_CONFIG_MISSING",
      "Не задано подключение к базе Workflow",
    );
  }

  const pool = createApplicationDatabasePool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      const purged = await purgeOrphanedWorkflowRuns(client, WORKFLOW_ORPHAN_RUN_PURGE_BATCH);
      if (purged > 0) {
        console.info(JSON.stringify({ code: WORKFLOW_ORPHAN_RUNS_PURGED_CODE, purged }));
      }
      return purged;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
