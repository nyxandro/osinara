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
import pg from "pg";

import { AppError } from "../app-error.js";

const { Client } = pg;
const EVE_RUN_ID_PATTERN = /^wrun_[A-Z0-9]{26}$/u;
const TERMINAL_RUN_STATUSES = new Set(["cancelled", "completed", "failed"]);

/** Read-only proof used by the explicit operator recovery, without re-enqueuing a Workflow run. */
export async function isConfiguredEveSessionTerminal(runId: string): Promise<boolean> {
  if (!EVE_RUN_ID_PATTERN.test(runId)) throw new AppError("AGENT_EVE_SESSION_ID_INVALID", "Некорректный идентификатор Eve-сессии");
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) throw new AppError("AGENT_WORKFLOW_DATABASE_CONFIG_MISSING", "Не задано подключение к базе Workflow");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ status: string }>("SELECT status::text FROM workflow.workflow_runs WHERE id = $1", [runId]);
    const status = result.rows[0]?.status;
    return status !== undefined && TERMINAL_RUN_STATUSES.has(status);
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
    const run = await client.query(
      "SELECT status::text AS status FROM workflow.workflow_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    const status = run.rows[0]?.status;
    if (typeof status !== "string") {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_MISSING",
        `Не найдены данные удаляемой Eve-сессии ${runId}`,
      );
    }
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      throw new AppError(
        "AGENT_EVE_SESSION_STORAGE_ACTIVE",
        `Eve-сессия ${runId} ещё выполняется и не может быть удалена`,
      );
    }

    // Hooks carry externally reusable tokens; only Workflow may end their retention window.
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
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await deletePostgresEveSession(runId, client);
  } finally {
    await client.end();
  }
}
