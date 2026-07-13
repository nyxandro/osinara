/**
 * Database migration runner.
 *
 * Constructs:
 * - Applies ordered SQL files once inside a PostgreSQL transaction.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных");
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  // The ledger must exist before the first authored migration creates the full schema.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Serialize replicas before they inspect the ledger, avoiding concurrent DDL application.
  await client.query("SELECT pg_advisory_lock(hashtextextended('osinara-schema-migrations', 0))");

  const directory = resolve("migrations");
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  for (const name of migrations) {
    const applied = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists",
      [name],
    );
    if (applied.rows[0]?.exists) continue;

    // Each file is atomic; a failed statement leaves both schema and ledger unchanged.
    const sql = await readFile(resolve(directory, name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
