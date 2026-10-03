/**
 * Monitoring views migration integration test.
 *
 * Constructs:
 * - `103_monitoring_views.sql`: aggregate-only views plus a read-only role for the metrics exporter.
 * - `105_memory_index_state_view.sql`: standing count of records the semantic branch cannot see.
 * - `114_memory_embedding_jobs_view_all_statuses.sql`: the indexing counter a runbook sends the
 *   duty reader to must answer with zeros, not with the silence an empty queue used to give.
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
  "monitoring_memory_embedding_backlog",
  "monitoring_memory_embedding_jobs",
  "monitoring_memory_index_state",
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

describeWithDatabase("monitoring views migrations", () => {
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
            column: expect.stringMatching(/^(pending|processing|failed|total|recent|status|phase|route_key|embedding_status|oldest_pending_age_seconds|stalled_oldest_age_seconds|longest_running_seconds|last_success_age_seconds|age_seconds)$/u),
          });
        }
      }
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });

  it("reports every indexing status even when no job is waiting", async () => {
    // A runbook step that sends the duty reader to a counter which disappears with an empty queue
    // answers «no failures», «no metric» and «wrong query» with the same silence.
    //
    // Emptying the whole table is the subject of this check, not a fixture: the view has to answer
    // exactly then. Integration files run one after another, so no neighbour loses its rows.
    await database().query("DELETE FROM memory_embedding_jobs");

    const result = await database().query<{ status: string; total: string; recent: string }>(
      "SELECT status, total, recent FROM monitoring_memory_embedding_jobs ORDER BY status",
    );

    expect(result.rows).toEqual([
      { status: "failed", total: "0", recent: "0" },
      { status: "leased", total: "0", recent: "0" },
      { status: "pending", total: "0", recent: "0" },
    ]);
  });

  it("keeps the reported statuses in step with the ones the table allows", async () => {
    // The view lists the statuses itself, so a new one would vanish from the metric in the same
    // silence this check exists to remove. Let the build notice it instead of the duty reader.
    const constraint = await database().query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'memory_embedding_jobs'::regclass AND conname = 'memory_embedding_jobs_status_check'`,
    );
    const allowed = [...constraint.rows[0]!.definition.matchAll(/'([a-z_]+)'::text/gu)]
      .map((match) => match[1]!).sort();
    expect(allowed.length).toBeGreaterThan(0);

    const reported = await database().query<{ status: string }>(
      "SELECT status FROM monitoring_memory_embedding_jobs ORDER BY status",
    );

    expect(reported.rows.map((row) => row.status)).toEqual(allowed);
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

  it("counts a record the semantic branch cannot see as a standing failed state", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Состояние индекса') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('index-state-owner', 'Владелец') RETURNING id`,
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO memory_items
         (family_id, owner_user_id, author_user_id, author_telegram_user_id, scope, kind,
          content, source, confirmation, sensitivity, operation_key, embedding_status)
       VALUES ($1, $2, $2, 'index-state-owner', 'personal', 'fact', 'Непроиндексированное сведение',
               'test:index-state', 'user_confirmed', 'normal', 'index-state', 'failed')`,
      [family.rows[0]!.id, user.rows[0]!.id],
    );

    const client = await database().connect();
    try {
      await client.query(`SET ROLE ${METRICS_ROLE}`);
      const result = await client.query<{ embedding_status: string; total: string }>(
        "SELECT embedding_status, total FROM public.monitoring_memory_index_state",
      );

      const failed = result.rows.find((row) => row.embedding_status === "failed");
      expect(Number(failed?.total)).toBeGreaterThanOrEqual(1);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
      // Integration files share one database and some of them count rows without a filter,
      // so this fixture removes itself instead of shifting a neighbouring test's totals.
      await database().query("DELETE FROM families WHERE id = $1", [family.rows[0]!.id]);
      await database().query("DELETE FROM users WHERE id = $1", [user.rows[0]!.id]);
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
