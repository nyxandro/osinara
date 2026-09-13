/** Upgrade coverage: preserve existing recurrence and derive counts only from confirmed runs. */
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
if (enabled && !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test")) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Нужна отдельная БД *_test");
}

(enabled ? describe : describe.skip)("schedule limits migration", () => {
  afterAll(closeDatabase);
  it("backfills confirmed completed runs, preserves unbounded schedules and enforces limits", async () => {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TEMP TABLE agent_schedules(id integer, recurrence_kind text, status text) ON COMMIT DROP;
        CREATE TEMP TABLE agent_schedule_runs(id integer, schedule_id integer, status text) ON COMMIT DROP;
        CREATE TEMP TABLE proactive_deliveries(source_id integer, source_kind text) ON COMMIT DROP;
        INSERT INTO agent_schedules VALUES (1,'minutely','active'),(2,'once','completed'),(3,'daily','paused');
        INSERT INTO agent_schedule_runs VALUES (10,1,'completed'),(11,1,'failed'),(12,1,'completed'),(20,2,'completed');
        INSERT INTO proactive_deliveries VALUES (10,'agent_schedule'),(10,'agent_schedule'),(11,'agent_schedule'),(20,'agent_schedule');`);
      await client.query(await readFile(new URL("../../../migrations/102_agent_schedule_limits.sql", import.meta.url), "utf8"));
      expect((await client.query("SELECT id,status,max_runs,completed_runs,pause_requested FROM agent_schedules ORDER BY id")).rows).toEqual([
        { id: 1, status: "active", max_runs: null, completed_runs: 1, pause_requested: false },
        { id: 2, status: "completed", max_runs: null, completed_runs: 1, pause_requested: false },
        { id: 3, status: "paused", max_runs: null, completed_runs: 0, pause_requested: false },
      ]);
      for (const sql of [
        "UPDATE agent_schedules SET max_runs=0 WHERE id=1",
        "UPDATE agent_schedules SET completed_runs=-1 WHERE id=1",
        "UPDATE agent_schedules SET max_runs=1,completed_runs=2 WHERE id=1",
        "UPDATE agent_schedules SET max_runs=2 WHERE id=2",
      ]) {
        await client.query("SAVEPOINT invalid_limit");
        await expect(client.query(sql)).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK TO SAVEPOINT invalid_limit");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
