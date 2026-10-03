/**
 * Migration 042 legacy group-session integration test.
 *
 * Constructs covered:
 * - Pending legacy branches become requester-bound tasks with only exact HITL prompt routes.
 * - Telegram route formulas are preserved for forum and main-topic prompts.
 * - Malformed legacy topic identifiers fail with a stable diagnostic instead of coercion.
 * - Non-pending legacy branches retire with retention while scheduled sessions remain separate.
 * - No canonical agent history is selected or copied during migration.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_group_canonical_session_migration";

async function createLegacySchema(client: PoolClient): Promise<void> {
  // This is the complete pre-042 dependency surface needed to execute the migration in isolation.
  await client.query(`
    CREATE TYPE memory_scope AS ENUM ('personal', 'family', 'group');
    CREATE TABLE families (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY, telegram_user_id text NOT NULL UNIQUE);
    CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id uuid NOT NULL REFERENCES families(id),
      actor_user_id uuid REFERENCES users(id),
      event_type text NOT NULL,
      subject_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE telegram_groups (id uuid PRIMARY KEY, telegram_chat_id text NOT NULL UNIQUE);
    CREATE TABLE conversation_sessions (
      id uuid PRIMARY KEY,
      thread_id uuid NOT NULL,
      generation integer NOT NULL,
      family_id uuid NOT NULL REFERENCES families(id),
      owner_user_id uuid REFERENCES users(id),
      group_id uuid REFERENCES telegram_groups(id) ON DELETE SET NULL,
      scope memory_scope NOT NULL,
      conversation_key text NOT NULL,
      continuation_token text NOT NULL UNIQUE,
      eve_session_id text UNIQUE,
      started_at timestamptz NOT NULL,
      last_activity_at timestamptz NOT NULL,
      completed_turns integer NOT NULL DEFAULT 0,
      pending_operation boolean NOT NULL DEFAULT false,
      rotation_requested_at timestamptz,
      retired_at timestamptz,
      delete_after timestamptz,
      retention_hold boolean NOT NULL DEFAULT false,
      retention_lease_token uuid,
      retention_lease_expires_at timestamptz,
      cleanup_error_code text,
      group_timeline_cursor bigint,
      UNIQUE (thread_id, generation)
    );
    CREATE UNIQUE INDEX conversation_sessions_active_thread
      ON conversation_sessions (thread_id) WHERE retired_at IS NULL;
    CREATE TABLE conversation_session_routes (
      base_continuation_token text PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE conversation_route_generations (
      route_owner text PRIMARY KEY,
      next_generation integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE telegram_hitl_approvals (
      id uuid PRIMARY KEY,
      application_session_id uuid NOT NULL REFERENCES conversation_sessions(id),
      eve_session_id text NOT NULL,
      request_id text NOT NULL,
      telegram_chat_id text NOT NULL,
      telegram_message_id bigint NOT NULL,
      telegram_message_thread_id bigint,
      expected_telegram_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      consumed_at timestamptz
    );
    CREATE TABLE agent_schedule_runs (
      id uuid PRIMARY KEY,
      application_session_id uuid REFERENCES conversation_sessions(id)
    );
  `);
}

describeWithDatabase("042 canonical group task session migration", () => {
  afterAll(closeDatabase);

  it("retires legacy branches and preserves only an exact pending HITL continuation", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      await createLegacySchema(client);

      await client.query(`
        INSERT INTO families VALUES ('00000000-0000-4000-8000-000000000001');
        INSERT INTO users VALUES (
          '00000000-0000-4000-8000-000000000002', 'requester-1'
        );
        INSERT INTO telegram_groups VALUES (
          '00000000-0000-4000-8000-000000000003', '-1001'
        );
        INSERT INTO conversation_sessions
          (id, thread_id, generation, family_id, group_id, scope, conversation_key,
           continuation_token, eve_session_id, started_at, last_activity_at, pending_operation)
        VALUES
          ('00000000-0000-4000-8000-000000000010',
           '00000000-0000-4000-8000-000000000110', 0,
           '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000003', 'family', '-1001:55:10',
           '-1001:55:10', 'wrun_pending', now(), now(), true),
          ('00000000-0000-4000-8000-000000000011',
           '00000000-0000-4000-8000-000000000111', 0,
           '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000003', 'family', '-1001::11',
           '-1001::11', 'wrun_pending_main', now(), now(), true),
          ('00000000-0000-4000-8000-000000000020',
           '00000000-0000-4000-8000-000000000120', 0,
           '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000003', 'family', '-1001:55:20',
           '-1001:55:20', 'wrun_old', now(), now(), false),
          ('00000000-0000-4000-8000-000000000030',
           '00000000-0000-4000-8000-000000000130', 0,
           '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000003', 'family', '-1001:55:schedule',
           '-1001:55:schedule', 'wrun_schedule', now(), now(), false);
        INSERT INTO agent_schedule_runs VALUES (
          '00000000-0000-4000-8000-000000000031',
          '00000000-0000-4000-8000-000000000030'
        );
        INSERT INTO telegram_hitl_approvals VALUES (
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000010', 'wrun_pending', 'request-1',
           '-1001', 500, 55, 'requester-1', now(), NULL
        ), (
          '00000000-0000-4000-8000-000000000012',
          '00000000-0000-4000-8000-000000000011', 'wrun_pending_main', 'request-main',
          '-1001', 501, NULL, 'requester-1', now(), NULL
        );
        INSERT INTO conversation_session_routes VALUES
          ('-1001:55:500', '00000000-0000-4000-8000-000000000010', now()),
          ('-1001:55:499', '00000000-0000-4000-8000-000000000010', now()),
          ('-1001::501', '00000000-0000-4000-8000-000000000011', now()),
          ('-1001::498', '00000000-0000-4000-8000-000000000011', now()),
          ('-1001:55:20', '00000000-0000-4000-8000-000000000020', now());
      `);

      await client.query(await readFile(
        resolve("migrations/042_canonical_group_task_sessions.sql"),
        "utf8",
      ));

      const sessions = await client.query(`
        SELECT id::text, kind::text, task_state::text, pending_operation,
               telegram_forum_topic_id::text,
               requester_user_id::text, requester_telegram_user_id, pending_request_id,
               retired_at IS NOT NULL AS retired, delete_after IS NOT NULL AS retained
        FROM conversation_sessions ORDER BY id
      `);
      expect(sessions.rows).toEqual([
        expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000010",
          kind: "task",
          pending_operation: true,
          pending_request_id: "request-1",
          requester_telegram_user_id: "requester-1",
          requester_user_id: "00000000-0000-4000-8000-000000000002",
          retired: false,
          task_state: "pending",
          telegram_forum_topic_id: "55",
        }),
        expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000011",
          kind: "task",
          pending_request_id: "request-main",
          retired: false,
          task_state: "pending",
          telegram_forum_topic_id: null,
        }),
        expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000020",
          kind: "canonical",
          retained: true,
          retired: true,
        }),
        expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000030",
          kind: "scheduled",
          retired: false,
          task_state: "running",
        }),
      ]);
      await expect(client.query(
        "SELECT base_continuation_token FROM conversation_session_routes ORDER BY 1",
      )).resolves.toMatchObject({
        rows: [
          { base_continuation_token: "-1001::501" },
          { base_continuation_token: "-1001:55:500" },
        ],
      });
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });

  it("fails clearly when a pending legacy group has a malformed topic segment", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await createLegacySchema(client);
      await client.query(`
        INSERT INTO families VALUES ('00000000-0000-4000-8000-000000000001');
        INSERT INTO telegram_groups VALUES (
          '00000000-0000-4000-8000-000000000003', '-1001'
        );
        INSERT INTO conversation_sessions
          (id, thread_id, generation, family_id, group_id, scope, conversation_key,
           continuation_token, eve_session_id, started_at, last_activity_at, pending_operation)
        VALUES
          ('00000000-0000-4000-8000-000000000010',
           '00000000-0000-4000-8000-000000000110', 0,
           '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000003', 'family', '-1001:not-a-topic:10',
           '-1001:not-a-topic:10', 'wrun_malformed', now(), now(), true);
      `);

      await expect(client.query(await readFile(
        resolve("migrations/042_canonical_group_task_sessions.sql"),
        "utf8",
      ))).rejects.toThrow("AGENT_MIGRATION_042_INVALID_TELEGRAM_ID");
    } finally {
      try {
        await client.query("RESET search_path");
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
    }
  });
});
