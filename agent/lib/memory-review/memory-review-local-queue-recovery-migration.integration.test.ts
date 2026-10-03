/**
 * Migration 072 local Workflow queue incident recovery tests.
 *
 * Constructs covered:
 * - Only the exact side-effect-free production batch is converted to a recoverable background batch.
 * - The active canonical chat session remains untouched.
 * - The retained source expands to 50 exact user entries without duplicating a completed successor.
 * - Only a same-family mutation from the successor turn blocks recovery.
 * - Later turns and operations owned by another family do not block the incident repair.
 * - Changed incident identity or overlapping source ownership aborts the migration atomically.
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
const MIGRATION_NAME = "072_memory_review_local_queue_recovery.sql";
const MIGRATION_ORDINAL = 72;
const TEST_SCHEMA = "test_memory_review_local_queue_recovery";
const INCIDENT_BATCH_ID = "c0cdfedb-2631-44b8-be4f-f1eb0b03b46a";
const SUCCESSOR_BATCH_ID = "6e5cf73b-6375-41d9-8bf8-e627c28784c3";
const APPLICATION_SESSION_ID = "bafe368d-04ec-4ec8-ab99-4a6803379f42";
const SUCCESSOR_AGENT_SESSION_ID = "wrun_01M04ST8SKEVWWK14WRSH1FPYG";
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

describeWithDatabase("072 local Workflow queue recovery", () => {
  afterAll(closeDatabase);

  it("requeues the exact pre-model interactive incident without rotating the live chat", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      // Reconstruct the inspected production trust zone and the 50 exact user sources.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Local queue recovery') RETURNING id",
      );
      const otherFamily = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Unrelated family') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('local-queue-owner', 'Владелец') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-local-queue', 'Остриков пилит агентов',
                 'family_private', 'addressed_only') RETURNING id`,
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
         SELECT $1, $2, sequence, sequence,
                CASE WHEN sequence = 7620 THEN 'agent_self' ELSE 'user' END,
                CASE WHEN sequence = 7620 THEN 'agent:osinara' ELSE 'telegram:local-queue-owner' END,
                CASE WHEN sequence = 7620 THEN NULL ELSE 'local-queue-owner' END,
                CASE WHEN sequence = 7620 THEN 'Осинара' ELSE 'Участник' END,
                sequence = 7620, 'text', 'Сообщение ' || sequence, now()
           FROM generate_series(7609, 7659) AS sequence`,
        [conversation.rows[0]!.id, group.rows[0]!.id],
      );
      const lane = await client.query<{ id: string }>(
        `INSERT INTO memory_review_lanes (conversation_id, processed_through_sequence)
         VALUES ($1, 7607) RETURNING id`,
        [conversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO conversation_sessions
           (id, thread_id, generation, family_id, group_id, scope, kind, conversation_key,
            continuation_token, eve_session_id, started_at, last_activity_at)
         VALUES ($1, gen_random_uuid(), 2, $2, $3, 'family', 'canonical', 'group:main',
                 'osinara:group:local-queue:main:osinara:2', 'wrun_current', now(), now())`,
        [APPLICATION_SESSION_ID, family.rows[0]!.id, group.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_review_batches
           (id, lane_id, conversation_id, batch_kind, status, predecessor_sequence,
            from_sequence, through_sequence, source_count, application_session_id,
            diagnostic_code, started_at, completed_at)
         VALUES ($1, $2, $3, 'interactive', 'ambiguous', 7607, 7609, 7609, 1, $4,
                 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS', now(), now()),
                ($5, $2, $3, 'interactive', 'completed', 7609, 7610, 7619, 10, $4,
                 NULL, now(), now())`,
        [INCIDENT_BATCH_ID, lane.rows[0]!.id, conversation.rows[0]!.id,
          APPLICATION_SESSION_ID, SUCCESSOR_BATCH_ID],
      );
      await client.query(
        `UPDATE memory_review_batches SET eve_session_id = $2, eve_turn_id = 'turn_0'
          WHERE id = $1`,
        [SUCCESSOR_BATCH_ID, SUCCESSOR_AGENT_SESSION_ID],
      );
      await client.query(
        `INSERT INTO memory_review_batch_sources
           (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
         SELECT $1, conversation_id, id, sequence_id FROM telegram_group_messages
          WHERE conversation_id = $2 AND sequence_id = 7609`,
        [INCIDENT_BATCH_ID, conversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_review_owner_alerts
           (batch_id, recovery_generation, family_id, group_id, group_title_snapshot,
            from_sequence, through_sequence, batch_diagnostic_code, status, completed_at)
         VALUES ($1, 0, $2, $3, 'Остриков пилит агентов', 7609, 7609,
                 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS', 'delivered', now())`,
        [INCIDENT_BATCH_ID, family.rows[0]!.id, group.rows[0]!.id],
      );
      const migration = await readFile(resolve("migrations", MIGRATION_NAME), "utf8");

      // A completed successor normally releases its sources. Any unexpected retained ownership must
      // block the repair rather than silently scheduling an overlapping review.
      await client.query(
        `INSERT INTO memory_review_batch_sources
           (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
         SELECT $1, conversation_id, id, sequence_id FROM telegram_group_messages
          WHERE conversation_id = $2 AND sequence_id BETWEEN 7610 AND 7619`,
        [SUCCESSOR_BATCH_ID, conversation.rows[0]!.id],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_SOURCE_OWNED",
      );
      await expect(client.query(
        "SELECT count(*)::integer AS count FROM memory_review_batch_sources WHERE batch_id = $1",
        [INCIDENT_BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await client.query("DELETE FROM memory_review_batch_sources WHERE batch_id = $1", [
        SUCCESSOR_BATCH_ID,
      ]);

      // A changed terminal diagnostic must roll back every attempted repair.
      await client.query(
        "UPDATE memory_review_batches SET diagnostic_code = 'CHANGED' WHERE id = $1",
        [INCIDENT_BATCH_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_STATE_INVALID",
      );
      await client.query(
        `UPDATE memory_review_batches
            SET diagnostic_code = 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS'
          WHERE id = $1`,
        [INCIDENT_BATCH_ID],
      );

      // The durable session continued after the inspected successor. Only an operation from its exact
      // turn proves a side effect; a later ordinary turn must not permanently block incident repair.
      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, eve_session_id, eve_turn_id)
         VALUES ($1, 'successor-turn-operation', 'create', $2, $3, 'turn_0'),
                ($1, 'later-session-operation', 'create', $2, $3, 'turn_15')`,
        [family.rows[0]!.id, "a".repeat(64), SUCCESSOR_AGENT_SESSION_ID],
      );
      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, eve_session_id, eve_turn_id)
         VALUES ($1, 'cross-family-turn-operation', 'create', $2, $3, 'turn_0')`,
        [otherFamily.rows[0]!.id, "b".repeat(64), SUCCESSOR_AGENT_SESSION_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_LOCAL_QUEUE_RECOVERY_SIDE_EFFECT_FOUND",
      );
      await client.query(
        `DELETE FROM memory_mutation_operations
          WHERE family_id = $1 AND operation_key = 'successor-turn-operation'`,
        [family.rows[0]!.id],
      );

      await client.query(migration);

      await expect(client.query(
        `SELECT batch_kind::text, status::text, recovery_attempts,
                last_recovery_diagnostic_code, application_session_id,
                from_sequence::text, through_sequence::text, source_count
           FROM memory_review_batches WHERE id = $1`,
        [INCIDENT_BATCH_ID],
      )).resolves.toMatchObject({ rows: [{
        application_session_id: null,
        batch_kind: "background",
        from_sequence: "7609",
        last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_LOCAL_QUEUE_TRANSPORT_TIMEOUT",
        recovery_attempts: 1,
        source_count: 50,
        status: "pending",
        through_sequence: "7659",
      }] });
      await expect(client.query(
        `SELECT count(*)::integer AS count, min(timeline_sequence)::text AS first,
                max(timeline_sequence)::text AS last
           FROM memory_review_batch_sources WHERE batch_id = $1`,
        [INCIDENT_BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ count: 50, first: "7609", last: "7659" }] });
      await expect(client.query(
        `SELECT eve_session_id, memory_review_batch_id, retired_at
           FROM conversation_sessions WHERE id = $1`,
        [APPLICATION_SESSION_ID],
      )).resolves.toMatchObject({ rows: [{
        eve_session_id: "wrun_current",
        memory_review_batch_id: null,
        retired_at: null,
      }] });
      await expect(client.query(
        `SELECT metadata FROM audit_events
          WHERE event_type = 'memory_review.operator_recovered' AND subject_id = $1`,
        [INCIDENT_BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ metadata: expect.objectContaining({
        recoveryAttempt: 1,
        throughSequence: 7659,
      }) }] });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query("RESET search_path");
      client.release();
    }
  });
});
