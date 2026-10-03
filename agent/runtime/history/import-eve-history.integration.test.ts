import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationDatabasePool } from "../../lib/database-client.js";
import { closeDatabase, database } from "../../lib/database.js";
import { storeLikeWorkflow, turnStepOutput } from "./eve-snapshot-fixtures.js";
import { loadSessionHistory } from "./history-repository.js";
import { createApplicationSession, ensureEveWorkflowDatabase } from "./history.integration-fixtures.js";
import { importEveHistory } from "./import-eve-history.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const workflowUrl = process.env.WORKFLOW_POSTGRES_URL;
const workflow = enabled && workflowUrl ? createApplicationDatabasePool({ connectionString: workflowUrl, max: 2 }) : null;

const SESSION = "wrun_01M0EVEHISTORYIMPORTTEST01";
const IDLE_SESSION = "wrun_01M0EVEHISTORYIMPORTTEST02";
const RETIRED_SESSION = "wrun_01M0EVEHISTORYIMPORTTEST03";
const BROKEN_SESSION = "wrun_01M0EVEHISTORYIMPORTTEST04";
const RUN_PREFIX = "wrun_01M0EVEHISTORYIMPORTRUN";
const TURN_STEP = "step//eve@0.40.0//turnStep";

const FIRST_TURN = [{ role: "user", content: "первый ход" }];
const LATEST_TURN = [
  ...FIRST_TURN,
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls", cwd: "/" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "json", value: { b: 1, a: 2 } } }] },
  { role: "user", content: "второй ход" },
];

let runs = 0;
async function insertTurn(sessionId: string, input: {
  completedMinutesAgo: number; status?: string; steps: Array<{ output: Uint8Array | null; minutesAgo: number; status?: string }>;
}): Promise<string> {
  runs += 1;
  const runId = `${RUN_PREFIX}${String(runs).padStart(2, "0")}`;
  await workflow!.query(
    `INSERT INTO workflow.workflow_runs (id, deployment_id, status, name, attributes, completed_at)
     VALUES ($1, 'deployment-test', $2::workflow.status, 'workflow//eve//turnWorkflow', $3::jsonb,
             (now() AT TIME ZONE 'UTC') - ($4::text || ' minutes')::interval)`,
    [runId, input.status ?? "completed", JSON.stringify({ "$eve.parent": sessionId, "$eve.type": "turn" }), String(input.completedMinutesAgo)],
  );
  for (const [index, step] of input.steps.entries()) {
    await workflow!.query(
      `INSERT INTO workflow.workflow_steps (run_id, step_id, step_name, status, attempt, output_cbor, completed_at)
       VALUES ($1, $2, $3, $4::workflow.step_status, 1, $5, (now() AT TIME ZONE 'UTC') - ($6::text || ' minutes')::interval)`,
      [runId, `${runId}-step-${index}`, TURN_STEP, step.status ?? "completed",
        step.output === null ? null : Buffer.from(step.output), String(step.minutesAgo)],
    );
  }
  return runId;
}

const SANDBOX_METADATA = {
  access: "trusted",
  mounts: [{ mountPoint: "personal", workspaceId: "11111111-1111-4111-8111-111111111111" }],
  sandboxSessionId: "thread_0123456789abcdef",
  version: 3,
};

function snapshot(sessionId: string, history: unknown[]) {
  return storeLikeWorkflow(turnStepOutput(sessionId, {
    history,
    compaction: { lastKnownInputTokens: 1200, lastKnownPromptMessageCount: history.length },
    sandboxState: { initialized: true, session: { backendName: "osinara-scoped-runner-v3", metadata: SANDBOX_METADATA, sessionKey: "k" } },
  }, {
    "eve.channel": { kind: "channel:telegram", state: { chatId: "912", chatType: "private", conversationId: null, messageThreadId: null, nextHitlCallbackId: 8 } },
    "eve.initiatorAuth": { attributes: { role: "owner" }, authenticator: "telegram", principalId: "telegram:912", principalType: "user" },
    "eve.dynamicSkillManifest": { scoped: [{ name: "pohuy", description: "Режим мата" }] },
    "eve.todo": { items: [{ content: "проверить", priority: "high", status: "pending" }] },
  }), "zstd");
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
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

(enabled && workflow ? describe : describe.skip)("Eve history import", () => {
  beforeAll(async () => { await ensureEveWorkflowDatabase(process.env.DATABASE_URL!, workflowUrl!, workflow!); });
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
    await workflow!.query("DELETE FROM workflow.workflow_steps WHERE run_id LIKE $1", [`${RUN_PREFIX}%`]);
    await workflow!.query("DELETE FROM workflow.workflow_runs WHERE id LIKE $1", [`${RUN_PREFIX}%`]);
  });
  afterAll(async () => {
    await workflow!.query("DELETE FROM workflow.workflow_steps WHERE run_id LIKE $1", [`${RUN_PREFIX}%`]);
    await workflow!.query("DELETE FROM workflow.workflow_runs WHERE id LIKE $1", [`${RUN_PREFIX}%`]);
    await workflow!.end();
    await closeDatabase();
  });

  it("carries over the latest completed turn of every active session and only once", async () => {
    await createApplicationSession(SESSION);
    await createApplicationSession(IDLE_SESSION);
    await createApplicationSession(RETIRED_SESSION, { retired: true });
    await insertTurn(SESSION, { completedMinutesAgo: 30, steps: [{ output: snapshot(SESSION, FIRST_TURN), minutesAgo: 30 }] });
    await insertTurn(SESSION, { completedMinutesAgo: 10, steps: [
      { output: snapshot(SESSION, FIRST_TURN), minutesAgo: 12 },
      { output: snapshot(SESSION, LATEST_TURN), minutesAgo: 10 },
      { output: null, minutesAgo: 9, status: "failed" },
    ] });
    // A turn that did not complete never became the session's state.
    await insertTurn(SESSION, { completedMinutesAgo: 1, status: "failed", steps: [{ output: snapshot(SESSION, []), minutesAgo: 1 }] });
    await insertTurn(RETIRED_SESSION, { completedMinutesAgo: 5, steps: [{ output: snapshot(RETIRED_SESSION, FIRST_TURN), minutesAgo: 5 }] });
    const log = vi.fn();

    const first = await inTransaction((app) => importEveHistory({ app, dryRun: false, log, workflow: async () => workflow! }));
    const second = await inTransaction((app) => importEveHistory({ app, dryRun: false, log: vi.fn(), workflow: async () => workflow! }));

    expect(first).toEqual([
      { messages: 4, outcome: "imported", sessionId: SESSION },
      { messages: 0, outcome: "source_absent", sessionId: IDLE_SESSION },
    ]);
    expect(second.map((session) => session.outcome)).toEqual(["already_imported", "already_imported"]);
    expect(log).toHaveBeenCalledWith({ code: "AGENT_EVE_HISTORY_SOURCE_ABSENT", sessionId: IDLE_SESSION });
    const imported = await loadSessionHistory(database(), SESSION);
    expect(JSON.stringify(imported.messages)).toBe(JSON.stringify(LATEST_TURN));
    expect(imported).toMatchObject({
      announcedSkills: [{ name: "pohuy", description: "Режим мата" }],
      compaction: { inputTokens: 1200, promptMessageCount: 4 },
    });
    // The session keeps its sandbox (container identity and folders), its channel state with the
    // button counter, its todo list, and its address: the next message of the chat reaches the same session.
    const state = (await database().query("SELECT sandbox_state, channel_state, initiator_auth, todo FROM agent_session_state WHERE session_id = $1", [SESSION])).rows[0];
    expect(state.sandbox_state).toEqual(SANDBOX_METADATA);
    expect(state.todo).toEqual({ items: [{ content: "проверить", priority: "high", status: "pending" }] });
    expect(state.initiator_auth).toMatchObject({ principalId: "telegram:912" });
    expect(state.channel_state).toMatchObject({ chatId: "912", nextHitlCallbackId: 8 });
    const address = (await database().query(
      `SELECT c.channel_kind, c.session_id FROM agent_continuations c JOIN conversation_sessions s ON s.continuation_token = c.token
        WHERE s.eve_session_id = $1`, [SESSION])).rows;
    expect(address).toEqual([{ channel_kind: "telegram", session_id: SESSION }]);
    expect((await loadSessionHistory(database(), IDLE_SESSION)).messages).toEqual([]);
    expect((await database().query("SELECT 1 FROM agent_session_state WHERE session_id = $1", [RETIRED_SESSION])).rowCount).toBe(0);
  });

  it("stops on an unreadable snapshot and leaves no session imported", async () => {
    await createApplicationSession(SESSION);
    await createApplicationSession(BROKEN_SESSION);
    await insertTurn(SESSION, { completedMinutesAgo: 10, steps: [{ output: snapshot(SESSION, FIRST_TURN), minutesAgo: 10 }] });
    await insertTurn(BROKEN_SESSION, { completedMinutesAgo: 10, steps: [{ output: new Uint8Array([1, 2, 3]), minutesAgo: 10 }] });

    await expect(inTransaction((app) => importEveHistory({ app, dryRun: false, log: vi.fn(), workflow: async () => workflow! })))
      .rejects.toThrow("AGENT_EVE_HISTORY_IMPORT_FAILED");
    expect((await database().query("SELECT count(*)::int AS n FROM agent_session_state")).rows[0].n).toBe(0);
  });

  it("refuses a snapshot that belongs to another session", async () => {
    await createApplicationSession(SESSION);
    await insertTurn(SESSION, { completedMinutesAgo: 10, steps: [{ output: snapshot(BROKEN_SESSION, FIRST_TURN), minutesAgo: 10 }] });

    await expect(inTransaction((app) => importEveHistory({ app, dryRun: false, log: vi.fn(), workflow: async () => workflow! })))
      .rejects.toThrow("AGENT_EVE_HISTORY_IMPORT_FAILED");
  });

  it("opens Eve's database only when a session still needs its history", async () => {
    const unavailable = vi.fn(async (): Promise<never> => { throw new Error("TEST_WORKFLOW_DATABASE_ABSENT"); });

    // A new installation: no conversations yet, and no Eve database either.
    await expect(inTransaction((app) => importEveHistory({ app, dryRun: false, log: vi.fn(), workflow: unavailable }))).resolves.toEqual([]);
    await createApplicationSession(SESSION);
    await insertTurn(SESSION, { completedMinutesAgo: 10, steps: [{ output: snapshot(SESSION, LATEST_TURN), minutesAgo: 10 }] });
    await inTransaction((app) => importEveHistory({ app, dryRun: false, log: vi.fn(), workflow: async () => workflow! }));
    // Every later release: all sessions already live in the runtime.
    await expect(inTransaction((app) => importEveHistory({ app, dryRun: false, log: vi.fn(), workflow: unavailable })))
      .resolves.toEqual([{ messages: 0, outcome: "already_imported", sessionId: SESSION }]);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("only reads and counts in a dry run, on read-only connections", async () => {
    await createApplicationSession(SESSION);
    await insertTurn(SESSION, { completedMinutesAgo: 10, steps: [{ output: snapshot(SESSION, LATEST_TURN), minutesAgo: 10 }] });
    const app = await database().connect();
    const reader = await workflow!.connect();
    try {
      await app.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
      await reader.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
      expect(await importEveHistory({ app, dryRun: true, log: vi.fn(), workflow: async () => reader }))
        .toEqual([{ messages: 4, outcome: "would_import", sessionId: SESSION }]);
    } finally {
      await app.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE");
      await reader.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE");
      app.release();
      reader.release();
    }
    expect((await database().query("SELECT count(*)::int AS n FROM agent_session_state")).rows[0].n).toBe(0);
  });
});
