/**
 * Database fixtures for runtime history integration tests.
 *
 * Exports:
 * - `createApplicationSession`: a family, its owner and one personal conversation session bound to
 *   the given runtime session id, as the application creates them before a turn.
 * - `ensureEveWorkflowDatabase`: the role, the database and the two tables of Eve's Workflow
 *   database the history import reads, with the columns and types of production
 *   (`osinara_workflow`, read 2026-10-02). Eve's own migrations created them; the build no longer
 *   carries those.
 *
 * Test-only: imported by `*.integration.test.ts` files, never by runtime code.
 */
import { randomUUID } from "node:crypto";

import { Client, type Pool } from "pg";

import { database } from "../../lib/database.js";

/** `adminUrl`: the test database's superuser connection; `workflow`: a pool on `workflowUrl`. */
export async function ensureEveWorkflowDatabase(adminUrl: string, workflowUrl: string, workflow: Pick<Pool, "query">): Promise<void> {
  const target = new URL(workflowUrl);
  const role = decodeURIComponent(target.username);
  const name = target.pathname.slice(1);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const quotedRole = admin.escapeIdentifier(role);
    if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount === 0) {
      await admin.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD ${admin.escapeLiteral(decodeURIComponent(target.password))}`);
    }
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 0) {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} OWNER ${quotedRole}`);
    }
  } finally {
    await admin.end();
  }
  await workflow.query(`
    CREATE SCHEMA IF NOT EXISTS workflow;
    DO $$ BEGIN
      CREATE TYPE workflow.status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE workflow.step_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS workflow.workflow_runs (
      id varchar PRIMARY KEY, output jsonb, deployment_id varchar NOT NULL, status workflow.status NOT NULL,
      name varchar NOT NULL, execution_context jsonb, input jsonb, error text,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
      completed_at timestamp, started_at timestamp, output_cbor bytea, execution_context_cbor bytea,
      input_cbor bytea, expired_at timestamp, spec_version varchar, error_cbor bytea, error_code varchar,
      attributes jsonb NOT NULL DEFAULT '{}'::jsonb, encryption_public_key varchar
    );
    CREATE TABLE IF NOT EXISTS workflow.workflow_steps (
      run_id varchar NOT NULL, step_id varchar PRIMARY KEY, step_name varchar NOT NULL,
      status workflow.step_status NOT NULL, input jsonb, output jsonb, error text, attempt integer NOT NULL,
      started_at timestamp, completed_at timestamp, created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(), retry_after timestamp, input_cbor bytea,
      output_cbor bytea, error_cbor bytea, spec_version integer
    );`);
}

export async function createApplicationSession(sessionId: string, options: { retired?: boolean } = {}) {
  const family = (await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('History test') RETURNING id",
  )).rows[0]!;
  const owner = (await database().query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Owner') RETURNING id",
    [String(Math.floor(Math.random() * 1e12))],
  )).rows[0]!;
  const key = randomUUID();
  const session = (await database().query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, owner_user_id, scope, kind, conversation_key, continuation_token,
        eve_session_id, started_at, last_activity_at, retired_at, delete_after)
     VALUES (gen_random_uuid(), 0, $1, $2, 'personal', 'canonical', $3, $3, $4, now(), now(),
             CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN now() + interval '30 days' END)
     RETURNING id`,
    [family.id, owner.id, key, sessionId, options.retired === true],
  )).rows[0]!;
  return { applicationSessionId: session.id, familyId: family.id };
}
