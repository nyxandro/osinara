/**
 * PostgreSQL connection boundary.
 *
 * Exports:
 * - `database`: lazily initialized connection pool.
 * - `closeDatabase`: graceful shutdown helper for scripts and tests.
 */
import type { Pool } from "pg";
import { createApplicationDatabasePool } from "./database-client.js";

let pool: Pool | null = null;

export function database(): Pool {
  // Resolve at first use so Eve discovery and image builds do not require runtime secrets.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных",
    );
  }
  if (pool === null) {
    pool = createApplicationDatabasePool({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  }
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
