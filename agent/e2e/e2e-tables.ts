/**
 * Tables the end-to-end test and the application under test share in the test database.
 *
 * Exports:
 * - `createE2eTables`, `dropE2eTables`: the journals of what the outside world saw — every
 *   Telegram API call, every model call, every sandbox session and command — and the switches the
 *   test flips to release a held command.
 * - `E2E_TABLES`: their names.
 *
 * Test-only: the application under test and the test process write and read them; production code
 * never does.
 */
import type { Pool } from "pg";

export const E2E_TABLES = {
  modelCalls: "e2e_model_calls",
  releases: "e2e_releases",
  sandboxProcesses: "e2e_sandbox_processes",
  sandboxSessions: "e2e_sandbox_sessions",
  telegramCalls: "e2e_telegram_calls",
} as const;

export async function createE2eTables(db: Pick<Pool, "query">): Promise<void> {
  await dropE2eTables(db);
  await db.query(`
    CREATE TABLE ${E2E_TABLES.telegramCalls} (
      id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000) PRIMARY KEY,
      method text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ${E2E_TABLES.modelCalls} (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      marker text NOT NULL, role text NOT NULL, tool_results integer NOT NULL, tools text[] NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ${E2E_TABLES.sandboxSessions} (
      sandbox_session_id text NOT NULL, access text NOT NULL, mounts jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE ${E2E_TABLES.sandboxProcesses} (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sandbox_session_id text NOT NULL, command text NOT NULL, finished boolean NOT NULL DEFAULT false);
    CREATE TABLE ${E2E_TABLES.releases} (marker text PRIMARY KEY);`);
}

export async function dropE2eTables(db: Pick<Pool, "query">): Promise<void> {
  await db.query(`DROP TABLE IF EXISTS ${Object.values(E2E_TABLES).join(", ")}`);
}
