/**
 * Monitoring views migration integration test.
 *
 * Constructs:
 * - `103_monitoring_views.sql`: aggregate-only views plus a read-only role for the metrics exporter.
 * - Each view is granted explicitly: a blanket schema grant would also cover future tables.
 * - The security boundary: the exporter role reads counts and ages, never a row of user content.
 * - The role guard: an inherited role carrying wider privileges stops the migration instead of
 *   silently becoming a credential that reads everything once the operator grants it a password.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

const METRICS_ROLE = "osinara_metrics";
const MONITORING_VIEWS = [
  "monitoring_agent_schedule_runs",
  "monitoring_memory_embedding_jobs",
  "monitoring_memory_review_batches",
  "monitoring_model_availability",
  "monitoring_operational_incidents",
  "monitoring_runtime_maintenance",
  "monitoring_telegram_ingress",
] as const;
// Reading any of these would turn an infrastructure credential into access to family data.
const FORBIDDEN_TABLES = [
  "public.memory_items",
  "public.telegram_ingress_updates",
  "public.telegram_group_messages",
  "public.users",
] as const;

describeWithDatabase("103 monitoring views migration", () => {
  afterAll(async () => {
    await database().query("RESET ROLE").catch(() => undefined);
    await closeDatabase();
  });

  it("creates the exporter role without the ability to log in on its own", async () => {
    const role = await database().query<{ rolcanlogin: boolean; rolsuper: boolean }>(
      "SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1",
      [METRICS_ROLE],
    );

    expect(role.rowCount).toBe(1);
    // The password is granted once by the operator on the server; the migration must not carry one.
    expect(role.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false });
  });

  it("exposes every monitoring view to the exporter role", async () => {
    for (const view of MONITORING_VIEWS) {
      const granted = await database().query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1, $2, 'SELECT') AS allowed",
        [METRICS_ROLE, `public.${view}`],
      );
      expect({ view, allowed: granted.rows[0]?.allowed }).toEqual({ view, allowed: true });
    }
  });

  it("denies the exporter role every table that holds user content", async () => {
    for (const table of FORBIDDEN_TABLES) {
      const granted = await database().query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1, $2, 'SELECT') AS allowed",
        [METRICS_ROLE, table],
      );
      expect({ table, allowed: granted.rows[0]?.allowed }).toEqual({ table, allowed: false });
    }
  });

  it("holds no privilege anywhere outside the monitoring views", async () => {
    const granted = await database().query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_name <> ALL($2::text[])`,
      [METRICS_ROLE, [...MONITORING_VIEWS]],
    );

    // A future view or an accidental grant elsewhere turns this credential into data access.
    expect(granted.rows.map(({ table_name }) => table_name)).toEqual([]);
  });

  it("answers every view as the exporter role itself and returns only numbers", async () => {
    const client = await database().connect();
    try {
      await client.query(`SET ROLE ${METRICS_ROLE}`);
      for (const view of MONITORING_VIEWS) {
        const result = await client.query(`SELECT * FROM public.${view}`);
        const columns = result.fields.map((field) => field.name).sort();
        expect({ view, empty: columns.length === 0 }).toEqual({ view, empty: false });
        // Identifiers of things, never their contents: route_key is a hash, phase and status are enums.
        for (const column of columns) {
          expect({ view, column }).toEqual({
            view,
            column: expect.stringMatching(/^(pending|processing|failed|total|recent|status|phase|route_key|oldest_pending_age_seconds|last_success_age_seconds|age_seconds)$/u),
          });
        }
      }
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });

  it("refuses a direct read of user content when acting as the exporter role", async () => {
    const client = await database().connect();
    try {
      await client.query(`SET ROLE ${METRICS_ROLE}`);
      await expect(client.query("SELECT id FROM memory_items LIMIT 1")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });

  /** The guard is the first statement of the migration and is safe to replay on its own. */
  async function roleGuardSql(): Promise<string> {
    const sql = await readFile(resolve("migrations/103_monitoring_views.sql"), "utf8");
    const end = sql.indexOf("CREATE VIEW");
    expect(end).toBeGreaterThan(0);
    return sql.slice(0, end);
  }

  it("stops the migration when the existing role already carries wider privileges", async () => {
    const guard = await roleGuardSql();
    const client = await database().connect();
    try {
      await expect(client.query(guard)).resolves.toBeDefined();

      await client.query(`ALTER ROLE ${METRICS_ROLE} BYPASSRLS`);
      await expect(client.query(guard)).rejects.toMatchObject({
        message: expect.stringContaining("AGENT_METRICS_ROLE_UNSAFE"),
      });
    } finally {
      await client.query(`ALTER ROLE ${METRICS_ROLE} NOBYPASSRLS`).catch(() => undefined);
      client.release();
    }
  });

  it("stops the migration when the existing role inherits another role's access", async () => {
    const guard = await roleGuardSql();
    const client = await database().connect();
    try {
      await client.query(`GRANT pg_read_all_data TO ${METRICS_ROLE}`);
      await expect(client.query(guard)).rejects.toMatchObject({
        message: expect.stringContaining("membership in pg_read_all_data"),
      });
    } finally {
      await client.query(`REVOKE pg_read_all_data FROM ${METRICS_ROLE}`).catch(() => undefined);
      client.release();
    }
  });

  it("accepts an existing role that the operator has merely given a password", async () => {
    const guard = await roleGuardSql();
    const client = await database().connect();
    try {
      await client.query(`ALTER ROLE ${METRICS_ROLE} LOGIN`);
      // Granting the password is the documented operator step, not a reason to fail the upgrade.
      await expect(client.query(guard)).resolves.toBeDefined();
    } finally {
      await client.query(`ALTER ROLE ${METRICS_ROLE} NOLOGIN`).catch(() => undefined);
      client.release();
    }
  });

  it("reports the ingress backlog as an age the exporter can alert on", async () => {
    const client = await database().connect();
    try {
      await client.query(`SET ROLE ${METRICS_ROLE}`);
      const result = await client.query<{
        oldest_pending_age_seconds: string;
        pending: string;
      }>("SELECT pending, oldest_pending_age_seconds FROM public.monitoring_telegram_ingress");

      expect(result.rowCount).toBe(1);
      expect(Number(result.rows[0]?.pending)).toBeGreaterThanOrEqual(0);
      expect(Number(result.rows[0]?.oldest_pending_age_seconds)).toBeGreaterThanOrEqual(0);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });
});
