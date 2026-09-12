/**
 * Migration 069 memory-review sandbox incident recovery tests.
 *
 * Constructs covered:
 * - The exact twice-failed pre-model production batch is requeued with intact source evidence.
 * - Existing owner-alert history remains durable across an operator-authorized recovery.
 * - A later terminal outcome receives a distinct alert generation instead of being suppressed.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { enqueueMemoryReviewOwnerAlert } from "./memory-review-owner-alert-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const MIGRATION_NAME = "069_memory_review_sandbox_recovery.sql";
const MIGRATION_ORDINAL = 69;
const TEST_SCHEMA = "test_memory_review_sandbox_recovery";
const BATCH_ID = "18329b3e-9563-4762-bc77-11641e8cbac1";
const ORIGINAL_APPLICATION_SESSION_ID = "61b08325-2147-4047-9cb1-01d8210b89b4";
const RECOVERY_APPLICATION_SESSION_ID = "26942f0e-76a7-4240-b241-ff866fc084b4";
const ORIGINAL_EVE_SESSION_ID = "wrun_01KZWTTV5XAJY71V8DW3E7EM4X";
const RECOVERY_EVE_SESSION_ID = "wrun_01KZZN63ATNDJSP336AVRKE1XW";
const MIGRATION_NAME_PATTERN = /^(\d+)_.*\.sql$/u;

function migrationOrdinal(name: string): number | null {
  const match = MIGRATION_NAME_PATTERN.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function applyMigrationsBefore069(client: import("pg").PoolClient): Promise<void> {
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

describeWithDatabase("069 memory review sandbox recovery migration", () => {
  afterAll(closeDatabase);

  it("requeues only the exact source-complete pre-model incident and advances alert generation", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore069(client);

      // Build the exact durable identity and source range verified from the production trace.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Sandbox recovery') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('sandbox-recovery-owner', 'Владелец') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-sandbox-recovery', 'Остриков пилит агентов',
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
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text,
            sent_at)
         SELECT $1, $2, sequence, sequence, 'user', 'telegram:sandbox-recovery-owner',
                'sandbox-recovery-owner', 'Владелец', false, 'text',
                'Сообщение ' || sequence, now()
           FROM generate_series(5540, 5589) AS sequence`,
        [conversation.rows[0]!.id, group.rows[0]!.id],
      );
      const lane = await client.query<{ id: string }>(
        `INSERT INTO memory_review_lanes
           (conversation_id, processed_through_sequence)
         VALUES ($1, 5539) RETURNING id`,
        [conversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_review_batches
           (id, lane_id, conversation_id, batch_kind, status, predecessor_sequence,
            from_sequence, through_sequence, source_count, eve_session_id, eve_turn_id,
            diagnostic_code, recovery_attempts, last_recovery_diagnostic_code,
            last_recovered_at, started_at, completed_at)
         VALUES ($1, $2, $3, 'background', 'ambiguous', 5539, 5540, 5589, 50,
                 $4, 'turn_0', 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS', 1,
                 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS', now(), now(), now())`,
        [BATCH_ID, lane.rows[0]!.id, conversation.rows[0]!.id, RECOVERY_EVE_SESSION_ID],
      );

      // Preserve both failed roots exactly as observed; neither root has a memory mutation row.
      await client.query(
        `INSERT INTO conversation_sessions
           (id, thread_id, generation, family_id, group_id, scope, kind, task_state,
            conversation_key, continuation_token, eve_session_id, started_at,
            last_activity_at, retired_at, delete_after, memory_review_batch_id)
         VALUES ($1::uuid, gen_random_uuid(), 0, $2, $3, 'family', 'proactive', 'failed',
                 $4, $5, $6, now(), now(), now(), now() + interval '90 days', NULL)`,
        [ORIGINAL_APPLICATION_SESSION_ID, family.rows[0]!.id, group.rows[0]!.id,
          BATCH_ID, `retired-memory-review:${ORIGINAL_APPLICATION_SESSION_ID}`,
          ORIGINAL_EVE_SESSION_ID],
      );
      await client.query(
        `INSERT INTO conversation_sessions
           (id, thread_id, generation, family_id, group_id, scope, kind, task_state,
            conversation_key, continuation_token, eve_session_id, started_at,
            last_activity_at, retired_at, delete_after, memory_review_batch_id)
         VALUES ($1::uuid, gen_random_uuid(), 1, $2, $3, 'family', 'proactive', 'failed',
                 $4, $5, $6, now(), now(), now(), now() + interval '90 days', $7::uuid)`,
        [RECOVERY_APPLICATION_SESSION_ID, family.rows[0]!.id, group.rows[0]!.id,
          BATCH_ID, `memory-review:${BATCH_ID}`, RECOVERY_EVE_SESSION_ID, BATCH_ID],
      );
      await client.query(
        "UPDATE memory_review_batches SET application_session_id = $2 WHERE id = $1",
        [BATCH_ID, RECOVERY_APPLICATION_SESSION_ID],
      );
      await client.query(
        `INSERT INTO memory_review_batch_sources
           (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
         SELECT $1, message.conversation_id, message.id, message.sequence_id
           FROM telegram_group_messages AS message
          WHERE message.conversation_id = $2
            AND message.sequence_id BETWEEN 5540 AND 5589`,
        [BATCH_ID, conversation.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_review_owner_alerts
           (batch_id, family_id, group_id, group_title_snapshot, from_sequence,
            through_sequence, batch_diagnostic_code, status, delivery_started_at, completed_at)
         VALUES ($1, $2, $3, 'Остриков пилит агентов', 5540, 5589,
                 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS', 'delivered', now(), now())`,
        [BATCH_ID, family.rows[0]!.id, group.rows[0]!.id],
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      await expect(client.query(
        `SELECT status::text, recovery_attempts, application_session_id, eve_session_id,
                diagnostic_code FROM memory_review_batches WHERE id = $1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{
        application_session_id: null,
        diagnostic_code: null,
        eve_session_id: null,
        recovery_attempts: 2,
        status: "pending",
      }] });
      await expect(client.query(
        `SELECT count(*)::integer AS count, min(timeline_sequence)::text AS first,
                max(timeline_sequence)::text AS last
           FROM memory_review_batch_sources WHERE batch_id = $1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ count: 50, first: "5540", last: "5589" }] });

      // A later terminal outcome must not be hidden by the already-delivered generation-one alert.
      // The current outbox implementation runs against its current schema, not the 069 snapshot.
      await client.query(await readFile(resolve("migrations/093_memory_review_model_recovery.sql"), "utf8"));
      await client.query(
        `UPDATE memory_review_batches SET status = 'failed',
                diagnostic_code = 'AGENT_MEMORY_REVIEW_TEST_TERMINAL', completed_at = now()
          WHERE id = $1`,
        [BATCH_ID],
      );
      await enqueueMemoryReviewOwnerAlert(
        client,
        BATCH_ID,
        "AGENT_MEMORY_REVIEW_TEST_TERMINAL",
      );
      await expect(client.query(
        `SELECT recovery_generation FROM memory_review_owner_alerts
          WHERE batch_id = $1 ORDER BY recovery_generation`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [
        { recovery_generation: 1 },
        { recovery_generation: 2 },
      ] });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query("RESET search_path");
      client.release();
    }
  });
});
