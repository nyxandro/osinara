/**
 * Migration 074 empty model response recovery tests.
 *
 * Constructs covered:
 * - Only the exact side-effect-free production batch is requeued after an empty model response.
 * - A mutation from the failed turn aborts recovery atomically.
 * - The failed session and delivered owner alert remain immutable audit history.
 * - All 50 retained source messages survive for a fresh background review root.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

// Migration tests destroy an isolated schema and must never target a production database.
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
const MIGRATION_NAME = "074_memory_review_empty_response_recovery.sql";
const MIGRATION_ORDINAL = 74;
const TEST_SCHEMA = "test_memory_review_empty_response_recovery";
const BATCH_ID = "287620e6-a391-40ff-bfc1-a0aeb628e819";
const APPLICATION_SESSION_ID = "e49ef485-3521-4df3-bc18-85f7efc62e91";
const AGENT_SESSION_ID = "wrun_01M05TN1SQZJM2ZPKGVE50NHH3";
const MIGRATION_NAME_PATTERN = /^(\d+)_.*\.sql$/u;

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

describeWithDatabase("074 empty model response recovery", () => {
  afterAll(closeDatabase);

  it("requeues the exact source-complete turn only while it has no memory side effect", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      // Reconstruct the exact external-group trust zone and retained production source range.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Empty response recovery') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('empty-response-owner', 'Владелец') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-empty-response', 'Остриков пилит агентов',
                 'external', 'addressed_only') RETURNING id`,
        [family.rows[0]!.id],
      );
      const conversation = await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
        [group.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         SELECT $1, $2, sequence, sequence, 'user', 'telegram:empty-response-owner',
                'empty-response-owner', 'Владелец', false, 'text',
                'Сообщение ' || sequence, now()
           FROM generate_series(7660, 7709) AS sequence`,
        [conversation.rows[0]!.id, group.rows[0]!.id],
      );
      const lane = await client.query<{ id: string }>(
        `INSERT INTO memory_review_lanes (conversation_id, processed_through_sequence)
         VALUES ($1, 7659) RETURNING id`,
        [conversation.rows[0]!.id],
      );

      // The model call reached a terminal empty response before any remember invocation.
      await client.query(
        `INSERT INTO memory_review_batches
           (id, lane_id, conversation_id, batch_kind, status, predecessor_sequence,
            from_sequence, through_sequence, source_count, eve_session_id, eve_turn_id,
            diagnostic_code, started_at, completed_at)
         VALUES ($1, $2, $3, 'background', 'failed', 7659, 7660, 7709, 50,
                 $4, 'turn_0', 'MODEL_CALL_FAILED', now(), now())`,
        [BATCH_ID, lane.rows[0]!.id, conversation.rows[0]!.id, AGENT_SESSION_ID],
      );
      await client.query(
        `INSERT INTO conversation_sessions
           (id, thread_id, generation, family_id, group_id, scope, kind, task_state,
            conversation_key, continuation_token, eve_session_id, pending_operation,
            started_at, last_activity_at, retired_at, delete_after, memory_review_batch_id)
         VALUES ($1, gen_random_uuid(), 0, $2, $3, 'group', 'proactive', 'failed',
                 $4, $4, $5, false, now(), now(), now(), now() + interval '1 day', $6)`,
        [APPLICATION_SESSION_ID, family.rows[0]!.id, group.rows[0]!.id,
          `memory-review:${BATCH_ID}`, AGENT_SESSION_ID, BATCH_ID],
      );
      await client.query(
        "UPDATE memory_review_batches SET application_session_id = $2 WHERE id = $1",
        [BATCH_ID, APPLICATION_SESSION_ID],
      );
      await client.query(
        `INSERT INTO memory_review_batch_sources
           (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
         SELECT $1, message.conversation_id, message.id, message.sequence_id
           FROM telegram_group_messages AS message
          WHERE message.conversation_id = $2 AND message.sequence_id BETWEEN 7660 AND 7709`,
        [BATCH_ID, conversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_review_owner_alerts
           (batch_id, recovery_generation, family_id, group_id, group_title_snapshot,
            from_sequence, through_sequence, batch_diagnostic_code, status, completed_at)
         VALUES ($1, 0, $2, $3, 'Остриков пилит агентов', 7660, 7709,
                 'MODEL_CALL_FAILED', 'delivered', now())`,
        [BATCH_ID, family.rows[0]!.id, group.rows[0]!.id],
      );
      const migration = await readFile(resolve("migrations", MIGRATION_NAME), "utf8");

      // Exact-turn provenance must fail closed even when the retained source snapshot is intact.
      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, eve_session_id, eve_turn_id)
         VALUES ($1, 'empty-response-operation', 'create', $2, $3, 'turn_0')`,
        [family.rows[0]!.id, "a".repeat(64), AGENT_SESSION_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_EMPTY_RESPONSE_RECOVERY_SIDE_EFFECT_FOUND",
      );
      await client.query(
        `DELETE FROM memory_mutation_operations
          WHERE family_id = $1 AND operation_key = 'empty-response-operation'`,
        [family.rows[0]!.id],
      );

      await client.query(migration);

      await expect(client.query(
        `SELECT status::text, recovery_attempts, last_recovery_diagnostic_code,
                application_session_id, eve_session_id, diagnostic_code
           FROM memory_review_batches WHERE id = $1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{
        application_session_id: null,
        diagnostic_code: null,
        eve_session_id: null,
        last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_EMPTY_MODEL_RESPONSE",
        recovery_attempts: 1,
        status: "pending",
      }] });
      await expect(client.query(
        `SELECT count(*)::integer AS count, min(timeline_sequence)::text AS first,
                max(timeline_sequence)::text AS last
           FROM memory_review_batch_sources WHERE batch_id = $1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ count: 50, first: "7660", last: "7709" }] });
      await expect(client.query(
        `SELECT continuation_token, memory_review_batch_id, task_state::text, retired_at
           FROM conversation_sessions WHERE id = $1`,
        [APPLICATION_SESSION_ID],
      )).resolves.toMatchObject({ rows: [{
        continuation_token: `retired-memory-review:${APPLICATION_SESSION_ID}`,
        memory_review_batch_id: null,
        retired_at: expect.any(Date),
        task_state: "failed",
      }] });
      await expect(client.query(
        `SELECT count(*)::integer AS count FROM audit_events
          WHERE event_type = 'memory_review.operator_recovered' AND subject_id = $1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(client.query(
        `SELECT recovery_generation, status::text FROM memory_review_owner_alerts
          WHERE batch_id = $1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ recovery_generation: 0, status: "delivered" }] });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query("RESET search_path");
      client.release();
    }
  });
});
