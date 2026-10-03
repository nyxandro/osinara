/**
 * PostgreSQL connection boundary.
 *
 * Exports:
 * - `database`: lazily initialized connection pool.
 * - `openDedicatedConnection`: a fresh connection outside the pool, for a hold that lasts as long
 *   as its session, such as the runner lock; its queries are short checks; the caller ends it.
 * - `closeDatabase`: graceful shutdown helper for scripts and tests.
 */
import type { Client, Pool } from "pg";
import { createApplicationDatabaseClient, createApplicationDatabasePool } from "./database-client.js";
import { normalizePostgresError } from "./database-errors.js";

const CONNECTION_TIMEOUT_MILLISECONDS = 5_000;
const DEDICATED_QUERY_TIMEOUT_MILLISECONDS = 5_000;

let pool: Pool | null = null;

function connectionString(): string {
  // Resolve at first use so builds and image builds do not require runtime secrets.
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных",
    );
  }
  return value;
}

export async function openDedicatedConnection(): Promise<Client> {
  const client = createApplicationDatabaseClient({
    connectionString: connectionString(),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    // Held for hours: a peer that vanished without closing is noticed, and a short check on a
    // half-dead connection fails instead of hanging the minute recovery that waits on it.
    keepAlive: true,
    query_timeout: DEDICATED_QUERY_TIMEOUT_MILLISECONDS,
  });
  try {
    await client.connect();
  } catch (error) {
    throw normalizePostgresError(error);
  }
  return client;
}

export function database(): Pool {
  const url = connectionString();
  if (pool === null) {
    // `min` keeps a few connections past pg-pool's 10-second idle close. Under memory pressure
    // PostgreSQL cannot start a new backend within the connect timeout, while open ones keep working (#285).
    pool = createApplicationDatabasePool({ connectionString: url, max: 10, min: 3, connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS });
  }
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
