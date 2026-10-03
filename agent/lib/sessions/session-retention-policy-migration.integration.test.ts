/**
 * Migration 073: retention policy of terminal session streams.
 *
 * Constructs covered:
 * - Existing retired application sessions are capped at one day without releasing retention holds.
 * - Active sessions retain no deletion deadline.
 * - Telegram trust-zone retirement applies the same one-day physical-retention deadline.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

// Migration tests destroy an isolated schema and must never run against a production database.
if (integrationTestsEnabled) {
  if (!integrationDatabaseUrl) {
    throw new Error("AGENT_TEST_DATABASE_CONFIG_MISSING: Для integration-тестов не задан DATABASE_URL");
  }
  if (!new URL(integrationDatabaseUrl).pathname.slice(1).endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Integration-тесты разрешены только для БД с суффиксом _test",
    );
  }
}

const describeWithDatabase = integrationTestsEnabled ? describe : describe.skip;
const MIGRATION_NAME = "073_eve_terminal_stream_retention.sql";
const MIGRATION_ORDINAL = 73;
const MIGRATION_NAME_PATTERN = /^(\d+)_.*\.sql$/u;
const TEST_SCHEMA = "test_eve_terminal_stream_retention";

function migrationOrdinal(name: string): number | null {
  const match = MIGRATION_NAME_PATTERN.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function applyEarlierMigrations(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => {
      const ordinal = migrationOrdinal(name);
      return ordinal !== null && ordinal < MIGRATION_ORDINAL;
    })
    .sort((left, right) => {
      const difference = migrationOrdinal(left)! - migrationOrdinal(right)!;
      return difference || left.localeCompare(right);
    });
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("073 terminal session stream retention", () => {
  afterAll(closeDatabase);

  it("shortens retired deadlines and preserves active or held session guards", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      // Build one trust zone with terminal, held, and active session variants.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Stream retention') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('stream-retention-owner', 'Owner') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-stream-retention', 'Retention', 'family_private', 'all') RETURNING id`,
        [family.rows[0]!.id],
      );
      const sessions = await client.query<{ id: string; conversation_key: string }>(
        `INSERT INTO conversation_sessions
           (thread_id, generation, family_id, group_id, scope, kind, task_state,
            conversation_key, continuation_token, eve_session_id, started_at, last_activity_at,
            retired_at, delete_after, retention_hold)
         VALUES
           (gen_random_uuid(), 0, $1, $2, 'family', 'proactive', 'completed',
            'retired-completed', 'retired-completed', 'wrun_01KXB392VJ8YY13JMJ9YZAF5QR',
            '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', '2026-08-01T01:00:00Z',
            '2026-10-30T01:00:00Z', false),
           (gen_random_uuid(), 0, $1, $2, 'family', 'scheduled', 'failed',
            'retired-held', 'retired-held', 'wrun_01KXB3WRDW8D6K9YV82NFNSNKS',
            '2026-08-01T00:00:00Z', '2026-08-01T02:00:00Z', '2026-08-01T02:00:00Z',
            '2026-10-30T02:00:00Z', true),
           (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', NULL,
            'active-canonical', 'active-canonical', 'wrun_01KXB4EA5APPDAASE4GKT76XQS',
            '2026-08-01T00:00:00Z', '2026-08-01T03:00:00Z', NULL, NULL, false),
           (gen_random_uuid(), 0, $1, $2, 'family', 'task', 'running',
            'active-task', 'active-task', 'wrun_01KXB5EA5APPDAASE4GKT76XQS',
            '2026-08-01T00:00:00Z', '2026-08-01T04:00:00Z', NULL, NULL, false)
         RETURNING id, conversation_key`,
        [family.rows[0]!.id, group.rows[0]!.id],
      );
      const activeTask = sessions.rows.find((row) => row.conversation_key === "active-task")!;
      await client.query(
        `UPDATE conversation_sessions
            SET group_timeline_cursor = 42, telegram_forum_topic_id = 100
          WHERE id = $1`,
        [activeTask.id],
      );
      await client.query(
        `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
         VALUES ('-100-stream-retention:100:42', $1)`,
        [activeTask.id],
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      await expect(client.query(
        `SELECT conversation_key, retention_hold,
                extract(epoch FROM (delete_after - retired_at))::integer AS retention_seconds
           FROM conversation_sessions WHERE id = ANY($1::uuid[]) ORDER BY conversation_key`,
        [sessions.rows.map((row) => row.id)],
      )).resolves.toMatchObject({ rows: [
        { conversation_key: "active-canonical", retention_hold: false, retention_seconds: null },
        { conversation_key: "active-task", retention_hold: false, retention_seconds: null },
        { conversation_key: "retired-completed", retention_hold: false, retention_seconds: 86_400 },
        { conversation_key: "retired-held", retention_hold: true, retention_seconds: 86_400 },
      ] });

      // The rewritten trust-zone trigger must use the same policy for future retirements.
      await client.query("DELETE FROM telegram_groups WHERE id = $1", [group.rows[0]!.id]);
      await expect(client.query(
        `SELECT conversation_key, group_timeline_cursor, telegram_forum_topic_id,
                task_state::text,
                extract(epoch FROM (delete_after - retired_at))::integer AS retention_seconds
           FROM conversation_sessions
          WHERE conversation_key IN ('active-canonical', 'active-task')
          ORDER BY conversation_key`,
      )).resolves.toMatchObject({ rows: [
        {
          conversation_key: "active-canonical",
          group_timeline_cursor: null,
          retention_seconds: 86_400,
          task_state: null,
          telegram_forum_topic_id: null,
        },
        {
          conversation_key: "active-task",
          group_timeline_cursor: null,
          retention_seconds: 86_400,
          task_state: "failed",
          telegram_forum_topic_id: null,
        },
      ] });
      await expect(client.query(
        "SELECT 1 FROM conversation_session_routes WHERE session_id = $1",
        [activeTask.id],
      )).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
