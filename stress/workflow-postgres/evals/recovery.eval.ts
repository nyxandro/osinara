/** Real native PostgreSQL workflow reconnection; completed tools must not execute again. */
import pg from "pg";
import { defineEval } from "eve/evals";

export default defineEval({
  description: "Keeps one native session and exactly one effect per turn after every Workflow connection is interrupted.",
  timeoutMs: 180_000,
  async test(t) {
    const connectionString = process.env.WORKFLOW_POSTGRES_URL;
    const applicationUrl = process.env.DATABASE_URL;
    if (!connectionString || !applicationUrl || !new URL(applicationUrl).pathname.endsWith("_test")) {
      throw new Error("AGENT_TEST_DATABASE_UNSAFE: Требуется изолированное тестовое окружение");
    }
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query("CREATE TABLE workflow_stress_side_effects(ordinal integer PRIMARY KEY,recorded_at timestamptz NOT NULL DEFAULT now())");
      await t.send("stress-turn-1", { turnPolicy: "queue" });
      const sessionId = t.sessionId;
      const killed = await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`);
      t.log(`Interrupted native Workflow connections: ${killed.rowCount}`);
      await t.send("stress-turn-2", { turnPolicy: "queue" });
      await waitForEffect(2);
      await t.send("stress-turn-3", { turnPolicy: "queue" });
      await waitForEffect(3);
      const deadline = Date.now()+30_000;
      while (true) {
        const turns = await client.query("SELECT status FROM workflow.workflow_runs WHERE name='workflow//eve//turnWorkflow'");
        if (turns.rows.length === 3 && turns.rows.every(row => row.status === "completed")) break;
        if (Date.now()>=deadline) throw new Error("AGENT_TEST_NATIVE_TURNS_UNSETTLED");
        await new Promise(resolve => setTimeout(resolve,100));
      }
      if (t.sessionId !== sessionId) throw new Error("AGENT_TEST_SESSION_CHANGED");
      const rows = await client.query("SELECT ordinal FROM workflow_stress_side_effects ORDER BY ordinal");
      t.log(`Confirmed effects: ${JSON.stringify(rows.rows)}`);
      if (JSON.stringify(rows.rows) !== JSON.stringify([{ ordinal: 1 },{ ordinal: 2 },{ ordinal: 3 }])) {
        throw new Error("AGENT_TEST_EFFECTS_REPLAYED: Нарушено число выполненных действий");
      }
      t.succeeded();
      async function waitForEffect(ordinal: number) {
        const deadline = Date.now()+30_000;
        while (Date.now()<deadline) {
          const result = await client.query("SELECT 1 FROM workflow_stress_side_effects WHERE ordinal=$1", [ordinal]);
          if (result.rowCount === 1) return;
          await new Promise(resolve => setTimeout(resolve,100));
        }
        throw new Error(`AGENT_TEST_RECOVERY_STALLED: Не завершилось действие ${ordinal}`);
      }
    } finally {
      await client.query("DROP TABLE IF EXISTS workflow_stress_side_effects");
      await client.end();
    }
  },
});
