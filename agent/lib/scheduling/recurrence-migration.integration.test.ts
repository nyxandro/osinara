/** Upgrade compatibility: calendar rows survive; fixed intervals require an exact instant. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, database } from "../database.js";
import { nextAnchoredOccurrence } from "./next-occurrence.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const SCHEMA = "recurrence_periods_migration_test";

(enabled ? describe : describe.skip)("092 recurrence migration", () => {
  afterAll(closeDatabase);

  it("commits new enum values without rewriting existing calendar records", async () => {
    const migration = await readFile(resolve("migrations/092_schedule_recurrence_periods.sql"), "utf8");
    const client = await database().connect();
    try {
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      await client.query(`SET search_path TO ${SCHEMA}, public`);
      await client.query(`
        CREATE TYPE reminder_recurrence_unit AS ENUM ('daily', 'weekly', 'monthly');
        CREATE TYPE agent_schedule_recurrence_kind AS ENUM ('once', 'daily', 'weekly');
        CREATE TABLE reminders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recurrence_unit reminder_recurrence_unit,
          recurrence_interval int NOT NULL DEFAULT 1, occurrence_index int NOT NULL DEFAULT 0,
          recurrence_anchor_local timestamp NOT NULL DEFAULT '2026-03-28 09:00:00',
          timezone text NOT NULL DEFAULT 'Europe/Berlin', due_at timestamptz NOT NULL DEFAULT '2026-03-28T08:00:00Z'
        );
        CREATE TABLE agent_schedules (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recurrence_kind agent_schedule_recurrence_kind,
          recurrence_interval int NOT NULL DEFAULT 1, occurrence_index int NOT NULL DEFAULT 0,
          recurrence_anchor_local timestamp NOT NULL DEFAULT '2026-03-28 09:00:00',
          timezone text NOT NULL DEFAULT 'Europe/Berlin', next_run_at timestamptz NOT NULL DEFAULT '2026-03-28T08:00:00Z'
        );
        INSERT INTO reminders (recurrence_unit) VALUES (NULL), ('daily'), ('weekly'), ('monthly');
        INSERT INTO agent_schedules (recurrence_kind) VALUES ('once'), ('daily'), ('weekly');
      `);
      const before = await client.query(`
        SELECT 'reminder' AS source, to_jsonb(r) AS record FROM reminders r
        UNION ALL SELECT 'agent', to_jsonb(s) FROM agent_schedules s ORDER BY source, record
      `);
      await client.query("BEGIN");
      await client.query(migration);
      await client.query("COMMIT");
      const after = await client.query(`
        SELECT 'reminder' AS source, to_jsonb(r) - 'recurrence_anchor_at' AS record FROM reminders r
        UNION ALL SELECT 'agent', to_jsonb(s) - 'recurrence_anchor_at' FROM agent_schedules s ORDER BY source, record
      `);
      expect(after.rows).toEqual(before.rows);

      for (const [table, unitColumn] of [["reminders", "recurrence_unit"], ["agent_schedules", "recurrence_kind"]] as const) {
        const daily = await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE ${unitColumn} = 'daily'`);
        expect(await nextAnchoredOccurrence(client, table, daily.rows[0]!.id, new Date("2026-03-28T08:01:00Z")))
          .toEqual({ next_index: 1, next_run_at: new Date("2026-03-29T07:00:00Z") });
        for (const unit of ["minutely", "hourly"]) {
          await expect(client.query(`INSERT INTO ${table} (${unitColumn}) VALUES ($1)`, [unit]))
            .rejects.toMatchObject({ code: "23514", constraint: `${table}_fixed_recurrence_anchor_check` });
          await client.query(`INSERT INTO ${table} (${unitColumn}, recurrence_anchor_at) VALUES ($1, '2026-03-28T08:00:00Z')`, [unit]);
        }
        await client.query(`INSERT INTO ${table} (${unitColumn}) VALUES ('yearly'), ('monthly')`);
      }
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      client.release();
    }
  });
});
