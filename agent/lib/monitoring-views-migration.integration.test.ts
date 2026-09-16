/**
 * Monitoring views migration integration test.
 *
 * Constructs:
 * - `103_monitoring_views.sql`: aggregate-only views plus a read-only role for the metrics exporter.
 * - The security boundary: the exporter role reads counts and ages, never a row of user content.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;

const METRICS_ROLE = "osinara_metrics";
const MONITORING_VIEWS = [
  "agent_schedule_runs",
  "memory_embedding_jobs",
  "memory_review_batches",
  "model_availability",
  "operational_incidents",
  "runtime_maintenance",
  "telegram_ingress",
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
        [METRICS_ROLE, `monitoring.${view}`],
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

  it("answers every view as the exporter role itself and returns only numbers", async () => {
    const client = await database().connect();
    try {
      await client.query(`SET ROLE ${METRICS_ROLE}`);
      for (const view of MONITORING_VIEWS) {
        const result = await client.query(`SELECT * FROM monitoring.${view}`);
        const columns = result.fields.map((field) => field.name).sort();
        expect({ view, empty: columns.length === 0 }).toEqual({ view, empty: false });
        // Identifiers of things, never their contents: route_key is a hash, phase and status are enums.
        for (const column of columns) {
          expect({ view, column }).toEqual({
            view,
            column: expect.stringMatching(/^(pending|processing|failed|total|status|phase|schedule|route_key|oldest_pending_age_seconds|last_success_age_seconds|age_seconds)$/u),
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

  it("reports the ingress backlog as an age the exporter can alert on", async () => {
    const client = await database().connect();
    try {
      await client.query(`SET ROLE ${METRICS_ROLE}`);
      const result = await client.query<{
        oldest_pending_age_seconds: string;
        pending: string;
      }>("SELECT pending, oldest_pending_age_seconds FROM monitoring.telegram_ingress");

      expect(result.rowCount).toBe(1);
      expect(Number(result.rows[0]?.pending)).toBeGreaterThanOrEqual(0);
      expect(Number(result.rows[0]?.oldest_pending_age_seconds)).toBeGreaterThanOrEqual(0);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });
});
