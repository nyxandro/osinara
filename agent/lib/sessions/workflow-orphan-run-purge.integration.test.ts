/**
 * Purge of Workflow runs left behind by deleted sessions, against real Workflow storage.
 *
 * Constructs covered:
 * - A finished turn of a session that no longer exists is removed with every per-run row.
 * - Nothing of a live session is touched, nor a run that finished too recently, is still running,
 *   holds hooks, or is a session root itself.
 * - One pass removes at most the batch it was given; the next pass continues.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_ORPHAN_RUN_PURGE_AFTER_HOURS } from "../../config.js";
import { createApplicationDatabasePool } from "../database-client.js";
import { purgeOrphanedWorkflowRuns } from "./workflow-orphan-run-purge.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.WORKFLOW_POSTGRES_URL;
const describeWithDatabase = enabled ? describe : describe.skip;
const pool = enabled && url ? createApplicationDatabasePool({ connectionString: url, max: 2 }) : null;

const LIVE_ROOT = "wrun_01M0B0RPHANRVNPVRGETEST001";
const DELETED_ROOT = "wrun_01M0B0RPHANRVNPVRGETEST002";
const ORPHAN_TURN = "wrun_01M0B0RPHANRVNPVRGETEST003";
const LIVE_TURN = "wrun_01M0B0RPHANRVNPVRGETEST004";
const RECENT_ORPHAN = "wrun_01M0B0RPHANRVNPVRGETEST005";
const SLEEPING_ORPHAN_TIMER = "wrun_01M0B0RPHANRVNPVRGETEST006";
const HOOKED_ORPHAN = "wrun_01M0B0RPHANRVNPVRGETEST007";
const OLD_ROOT = "wrun_01M0B0RPHANRVNPVRGETEST008";
const SECOND_ORPHAN = "wrun_01M0B0RPHANRVNPVRGETEST009";
const FIXTURES = [
  LIVE_ROOT, DELETED_ROOT, ORPHAN_TURN, LIVE_TURN, RECENT_ORPHAN, SLEEPING_ORPHAN_TIMER,
  HOOKED_ORPHAN, OLD_ROOT, SECOND_ORPHAN,
];
const PER_RUN_TABLES = [
  "workflow_stream_chunks", "workflow_waits", "workflow_hooks", "workflow_steps",
  "workflow_events", "workflow_event_slots",
];

async function insertRun(runId: string, input: {
  status: string; rootRunId: string | null; finishedHoursAgo: number | null;
  name?: string; updatedHoursAgo?: number;
}) {
  const attributes = input.rootRunId === null ? {} : { $rootRunId: input.rootRunId };
  await pool!.query(
    `INSERT INTO workflow.workflow_runs
       (id, deployment_id, status, name, attributes, completed_at, updated_at)
     VALUES ($1, 'deployment-test', $2::workflow.status, $3, $4::jsonb,
             CASE WHEN $5::text IS NULL THEN NULL
                  ELSE (now() AT TIME ZONE 'UTC') - ($5::text || ' hours')::interval END,
             (now() AT TIME ZONE 'UTC') - ($6::text || ' hours')::interval)`,
    [runId, input.status, input.name ?? "workflow//eve//turnWorkflow", JSON.stringify(attributes),
      input.finishedHoursAgo === null ? null : String(input.finishedHoursAgo),
      String(input.updatedHoursAgo ?? input.finishedHoursAgo ?? 0)],
  );
}

async function insertPayload(runId: string) {
  await pool!.query(
    "INSERT INTO workflow.workflow_events (id, type, run_id) VALUES ($1, 'test', $2)",
    [`event-${runId}`, runId],
  );
  await pool!.query(
    `INSERT INTO workflow.workflow_steps (run_id, step_id, step_name, status, attempt)
     VALUES ($1, $2, 'test-step', 'completed', 1)`,
    [runId, `step-${runId}`],
  );
  await pool!.query(
    `INSERT INTO workflow.workflow_stream_chunks (id, stream_id, data, eof, run_id)
     VALUES ($1, $2, '\\x00'::bytea, true, $3)`,
    [`chunk-${runId}`, `stream-${runId}`, runId],
  );
}

async function runExists(runId: string): Promise<boolean> {
  const result = await pool!.query("SELECT 1 FROM workflow.workflow_runs WHERE id = $1", [runId]);
  return result.rowCount === 1;
}

async function purge(batchSize: number): Promise<number> {
  const client = await pool!.connect();
  try {
    return await purgeOrphanedWorkflowRuns(client, batchSize);
  } finally {
    client.release();
  }
}

/** Before and after each case: a failed or interrupted test must not leave rows for the next one. */
async function removeFixtures() {
  for (const runId of FIXTURES) {
    for (const table of PER_RUN_TABLES) {
      await pool!.query(`DELETE FROM workflow.${table} WHERE run_id = $1`, [runId]);
    }
    await pool!.query("DELETE FROM workflow.workflow_runs WHERE id = $1", [runId]);
  }
}

const OLD_ENOUGH = WORKFLOW_ORPHAN_RUN_PURGE_AFTER_HOURS + 1;

describeWithDatabase("purgeOrphanedWorkflowRuns against Workflow storage", () => {
  beforeEach(removeFixtures);
  afterEach(removeFixtures);

  afterAll(async () => { await pool?.end(); });

  it("removes a finished turn of a deleted session together with every per-run row", async () => {
    await insertRun(ORPHAN_TURN, { status: "completed", rootRunId: DELETED_ROOT, finishedHoursAgo: OLD_ENOUGH });
    await insertPayload(ORPHAN_TURN);

    await expect(purge(10)).resolves.toBe(1);

    await expect(runExists(ORPHAN_TURN)).resolves.toBe(false);
    for (const table of PER_RUN_TABLES) {
      await expect(pool!.query(`SELECT 1 FROM workflow.${table} WHERE run_id = $1`, [ORPHAN_TURN]))
        .resolves.toMatchObject({ rowCount: 0 });
    }
  });

  it("keeps everything that still belongs to a live session or may still be woken", async () => {
    await insertRun(LIVE_ROOT, { status: "running", rootRunId: null, finishedHoursAgo: null, name: "workflow//eve//workflowEntry" });
    await insertRun(LIVE_TURN, { status: "completed", rootRunId: LIVE_ROOT, finishedHoursAgo: OLD_ENOUGH * 10 });
    // A cancelled run still receives the wake-up Workflow armed for it up to a day ahead; deleting
    // it before that fires would send the wake-up to a run that does not exist.
    await insertRun(RECENT_ORPHAN, {
      status: "cancelled", rootRunId: DELETED_ROOT, finishedHoursAgo: WORKFLOW_ORPHAN_RUN_PURGE_AFTER_HOURS - 1,
    });
    // A session timer outlives its deleted session and finishes on its own at the deadline; its
    // row is not updated while it sleeps, so only its status says it is not finished.
    await insertRun(SLEEPING_ORPHAN_TIMER, {
      status: "running", rootRunId: DELETED_ROOT, finishedHoursAgo: null,
      name: "workflow//eve//sessionTimeoutWorkflow", updatedHoursAgo: OLD_ENOUGH * 10,
    });
    await insertRun(HOOKED_ORPHAN, { status: "completed", rootRunId: DELETED_ROOT, finishedHoursAgo: OLD_ENOUGH });
    await pool!.query(
      `INSERT INTO workflow.workflow_hooks (run_id, hook_id, token, owner_id, project_id, environment)
       VALUES ($1, 'hook-orphan', 'token', 'owner', 'project', 'test')`,
      [HOOKED_ORPHAN],
    );
    // Session roots are retired by application session retention, never by this purge.
    await insertRun(OLD_ROOT, {
      status: "completed", rootRunId: null, finishedHoursAgo: OLD_ENOUGH * 10, name: "workflow//eve//workflowEntry",
    });

    await expect(purge(10)).resolves.toBe(0);

    for (const runId of [LIVE_ROOT, LIVE_TURN, RECENT_ORPHAN, SLEEPING_ORPHAN_TIMER, HOOKED_ORPHAN, OLD_ROOT]) {
      await expect(runExists(runId)).resolves.toBe(true);
    }
  });

  it("removes at most one batch per pass and continues on the next pass", async () => {
    await insertRun(ORPHAN_TURN, { status: "completed", rootRunId: DELETED_ROOT, finishedHoursAgo: OLD_ENOUGH });
    await insertRun(SECOND_ORPHAN, { status: "failed", rootRunId: DELETED_ROOT, finishedHoursAgo: OLD_ENOUGH });

    await expect(purge(1)).resolves.toBe(1);
    await expect(purge(1)).resolves.toBe(1);
    await expect(purge(1)).resolves.toBe(0);

    await expect(runExists(ORPHAN_TURN)).resolves.toBe(false);
    await expect(runExists(SECOND_ORPHAN)).resolves.toBe(false);
  });
});
