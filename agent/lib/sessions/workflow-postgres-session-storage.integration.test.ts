/**
 * Physical Eve session deletion against real Workflow storage.
 *
 * Constructs covered:
 * - A run still working is refused; a run with no event for longer than the threshold is removed.
 * - The hooks of an abandoned run go with it, while a terminal run with hooks stays refused.
 *
 * The statement behind this is the one that removes production data, and a unit test cannot see
 * whether PostgreSQL accepts it: the client there is a mock that returns prepared rows.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { EVE_RUN_ABANDONED_AFTER_HOURS } from "../../config.js";
import { createApplicationDatabasePool } from "../database-client.js";
import { deletePostgresEveSession } from "./workflow-postgres-session-storage.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.WORKFLOW_POSTGRES_URL;
const describeWithDatabase = enabled ? describe : describe.skip;
const pool = enabled && url ? createApplicationDatabasePool({ connectionString: url, max: 2 }) : null;

const ACTIVE_RUN = "wrun_01M0AZKZAKTGSH4QQZBBCJK001";
const ABANDONED_RUN = "wrun_01M0AZKZAKTGSH4QQZBBCJK002";
const TERMINAL_HOOKED_RUN = "wrun_01M0AZKZAKTGSH4QQZBBCJK003";
const SLEEPING_RUN = "wrun_01M0AZKZAKTGSH4QQZBBCJK004";

async function insertRun(runId: string, status: string, eventAgeHours: number | null) {
  await pool!.query(
    `INSERT INTO workflow.workflow_runs (id, deployment_id, status, name, attributes)
     VALUES ($1, 'deployment-test', $2::workflow.status, 'workflow//eve//turnWorkflow', '{}'::jsonb)`,
    [runId, status],
  );
  if (eventAgeHours === null) return;
  await pool!.query(
    `INSERT INTO workflow.workflow_events (id, type, run_id, created_at)
     VALUES ($1, 'test', $2, (now() AT TIME ZONE 'UTC') - ($3 || ' hours')::interval)`,
    [`event-${runId}`, runId, String(eventAgeHours)],
  );
}

async function insertHook(runId: string) {
  await pool!.query(
    `INSERT INTO workflow.workflow_hooks
       (run_id, hook_id, token, owner_id, project_id, environment)
     VALUES ($1, $2, 'token', 'owner', 'project', 'test')`,
    [runId, `hook-${runId}`],
  );
}

async function insertWait(runId: string, resumeInHours: number) {
  await pool!.query(
    `INSERT INTO workflow.workflow_waits (wait_id, run_id, status, resume_at)
     VALUES ($1, $2, 'waiting', (now() AT TIME ZONE 'UTC') + ($3 || ' hours')::interval)`,
    [`wait-${runId}`, runId, String(resumeInHours)],
  );
}

async function runExists(runId: string): Promise<boolean> {
  const result = await pool!.query("SELECT 1 FROM workflow.workflow_runs WHERE id = $1", [runId]);
  return result.rowCount === 1;
}

async function withClient(runId: string) {
  const client = await pool!.connect();
  try {
    await deletePostgresEveSession(runId, client);
  } finally {
    client.release();
  }
}

describeWithDatabase("deletePostgresEveSession against Workflow storage", () => {
  beforeEach(async () => {
    for (const runId of [ACTIVE_RUN, ABANDONED_RUN, TERMINAL_HOOKED_RUN, SLEEPING_RUN]) {
      await pool!.query("DELETE FROM workflow.workflow_waits WHERE run_id = $1", [runId]);
      await pool!.query("DELETE FROM workflow.workflow_hooks WHERE run_id = $1", [runId]);
      await pool!.query("DELETE FROM workflow.workflow_events WHERE run_id = $1", [runId]);
      await pool!.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [runId]);
    }
  });

  afterAll(async () => { await pool?.end(); });

  it("refuses a run that produced an event inside the abandonment window", async () => {
    await insertRun(ACTIVE_RUN, "running", EVE_RUN_ABANDONED_AFTER_HOURS - 1);

    await expect(withClient(ACTIVE_RUN)).rejects.toThrowError(/AGENT_EVE_SESSION_STORAGE_ACTIVE/u);
    await expect(runExists(ACTIVE_RUN)).resolves.toBe(true);
  });

  it("removes a run with no event for longer than the window, hooks included", async () => {
    await insertRun(ABANDONED_RUN, "running", EVE_RUN_ABANDONED_AFTER_HOURS + 1);
    await insertHook(ABANDONED_RUN);

    await expect(withClient(ABANDONED_RUN)).resolves.toBeUndefined();

    await expect(runExists(ABANDONED_RUN)).resolves.toBe(false);
    await expect(pool!.query(
      "SELECT 1 FROM workflow.workflow_hooks WHERE run_id = $1", [ABANDONED_RUN],
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("refuses a silent run that Workflow is scheduled to wake up later", async () => {
    // Half the stuck runs on production sleep on a future resume, some of them a month ahead:
    // silence is not abandonment while Workflow still intends to come back to the run.
    await insertRun(SLEEPING_RUN, "running", EVE_RUN_ABANDONED_AFTER_HOURS * 10);
    await insertWait(SLEEPING_RUN, 48);

    await expect(withClient(SLEEPING_RUN)).rejects.toThrowError(/AGENT_EVE_SESSION_STORAGE_ACTIVE/u);
    await expect(runExists(SLEEPING_RUN)).resolves.toBe(true);
  });

  it("keeps refusing a terminal run whose hooks are still held, however old it is", async () => {
    // Age says nothing about a finished run: its hooks keep their retention window either way.
    await insertRun(TERMINAL_HOOKED_RUN, "completed", EVE_RUN_ABANDONED_AFTER_HOURS * 10);
    await insertHook(TERMINAL_HOOKED_RUN);

    await expect(withClient(TERMINAL_HOOKED_RUN)).rejects.toThrowError(
      /AGENT_EVE_SESSION_HOOK_RETENTION_ACTIVE/u,
    );
    await expect(runExists(TERMINAL_HOOKED_RUN)).resolves.toBe(true);
  });
});
