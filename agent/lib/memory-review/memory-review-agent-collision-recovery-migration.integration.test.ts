/**
 * Migration 070 memory-review implicit-agent collision recovery tests.
 *
 * Constructs covered:
 * - Only the exact third pre-model production root is retired and requeued.
 * - The immutable 50-source batch survives while its failed turn binding is removed.
 * - Recovery and owner-alert generations advance without erasing prior incident history.
 * - Recovery remains bounded after the operator-authorized third attempt.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const MIGRATION_NAME = "070_memory_review_agent_collision_recovery.sql";
const MIGRATION_ORDINAL = 70;
const TEST_SCHEMA = "test_memory_review_agent_collision_recovery";
const BATCH_ID = "18329b3e-9563-4762-bc77-11641e8cbac1";
const ORIGINAL_APPLICATION_SESSION_ID = "61b08325-2147-4047-9cb1-01d8210b89b4";
const SANDBOX_APPLICATION_SESSION_ID = "26942f0e-76a7-4240-b241-ff866fc084b4";
const COLLISION_APPLICATION_SESSION_ID = "ced56a9b-e788-41e5-82fb-ac46e8b20168";
const ORIGINAL_AGENT_SESSION_ID = "wrun_01KZWTTV5XAJY71V8DW3E7EM4X";
const SANDBOX_AGENT_SESSION_ID = "wrun_01KZZN63ATNDJSP336AVRKE1XW";
const COLLISION_AGENT_SESSION_ID = "wrun_01KZZW3MVCRG9D57A0TWQ06M8D";
const MIGRATION_NAME_PATTERN = /^(\d+)_.*\.sql$/u;

function migrationOrdinal(name: string): number | null {
  const match = MIGRATION_NAME_PATTERN.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function applyMigrationsBefore070(client: import("pg").PoolClient): Promise<void> {
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

describeWithDatabase("070 memory review agent collision recovery migration", () => {
  afterAll(closeDatabase);

  it("requeues the exact side-effect-free collision root with generation-three audit", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore070(client);

      // Reconstruct the exact production identity and retained source interval.
      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Agent collision recovery') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('agent-collision-owner', 'Владелец') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-agent-collision', 'Остриков пилит агентов',
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
         SELECT $1, $2, sequence, sequence, 'user', 'telegram:agent-collision-owner',
                'agent-collision-owner', 'Владелец', false, 'text',
                'Сообщение ' || sequence, now()
           FROM generate_series(5540, 5589) AS sequence`,
        [conversation.rows[0]!.id, group.rows[0]!.id],
      );
      const lane = await client.query<{ id: string }>(
        `INSERT INTO memory_review_lanes (conversation_id, processed_through_sequence)
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
                 $4, 'turn_0', 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS', 2,
                 'AGENT_MEMORY_REVIEW_SANDBOX_CONTEXT_INVALID', now(), now(), now())`,
        [BATCH_ID, lane.rows[0]!.id, conversation.rows[0]!.id, COLLISION_AGENT_SESSION_ID],
      );

      // All earlier roots remain immutable retired history; only the current root owns the batch.
      const sessionValues = [
        [ORIGINAL_APPLICATION_SESSION_ID, ORIGINAL_AGENT_SESSION_ID, null],
        [SANDBOX_APPLICATION_SESSION_ID, SANDBOX_AGENT_SESSION_ID, null],
        [COLLISION_APPLICATION_SESSION_ID, COLLISION_AGENT_SESSION_ID, BATCH_ID],
      ] as const;
      for (const [id, agentSessionId, memoryReviewBatchId] of sessionValues) {
        await client.query(
          `INSERT INTO conversation_sessions
             (id, thread_id, generation, family_id, group_id, scope, kind, task_state,
              conversation_key, continuation_token, eve_session_id, started_at,
              last_activity_at, retired_at, delete_after, memory_review_batch_id)
           VALUES ($1::uuid, gen_random_uuid(), 0, $2, $3, 'family', 'proactive', 'failed',
                   $4, $5, $6, now(), now(), now(), now() + interval '90 days', $7::uuid)`,
          [id, family.rows[0]!.id, group.rows[0]!.id, `memory-review:${BATCH_ID}`,
            memoryReviewBatchId === null ? `retired-memory-review:${id}` : `memory-review:${BATCH_ID}`,
            agentSessionId, memoryReviewBatchId],
        );
      }
      await client.query(
        "UPDATE memory_review_batches SET application_session_id = $2 WHERE id = $1",
        [BATCH_ID, COLLISION_APPLICATION_SESSION_ID],
      );
      await client.query(
        `INSERT INTO memory_review_batch_sources
           (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
         SELECT $1, message.conversation_id, message.id, message.sequence_id
           FROM telegram_group_messages AS message
          WHERE message.conversation_id = $2 AND message.sequence_id BETWEEN 5540 AND 5589`,
        [BATCH_ID, conversation.rows[0]!.id],
      );
      await client.query(
         `INSERT INTO memory_turn_source_sets
            (eve_session_id, eve_turn_id, application_session_id, conversation_id,
             current_timeline_entry_id, invoking_telegram_user_id, binding_hash,
             memory_review_batch_id)
          VALUES ($1, 'turn_0', $2, $3, NULL, 'agent-collision-owner', $4, $5)`,
        [COLLISION_AGENT_SESSION_ID, COLLISION_APPLICATION_SESSION_ID,
          conversation.rows[0]!.id, "a".repeat(64), BATCH_ID],
      );
      await client.query(
        `INSERT INTO memory_turn_sources
           (eve_session_id, eve_turn_id, conversation_id, timeline_entry_id,
            timeline_sequence, is_current)
         SELECT $1, 'turn_0', source.conversation_id, source.timeline_entry_id,
                source.timeline_sequence, false
           FROM memory_review_batch_sources AS source WHERE source.batch_id = $2`,
        [COLLISION_AGENT_SESSION_ID, BATCH_ID],
      );
      await client.query(
        `INSERT INTO memory_review_owner_alerts
           (batch_id, recovery_generation, family_id, group_id, group_title_snapshot,
            from_sequence, through_sequence, batch_diagnostic_code, status, completed_at)
         VALUES
           ($1, 1, $2, $3, 'Остриков пилит агентов', 5540, 5589,
            'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS', 'delivered', now()),
           ($1, 2, $2, $3, 'Остриков пилит агентов', 5540, 5589,
            'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS', 'delivered', now())`,
        [BATCH_ID, family.rows[0]!.id, group.rows[0]!.id],
      );

      const migration = await readFile(resolve("migrations", MIGRATION_NAME), "utf8");

      // A mismatched binding must abort the entire migration, including its constraint widening.
      await client.query(
        `UPDATE memory_turn_source_sets SET application_session_id = $2
          WHERE memory_review_batch_id = $1`,
        [BATCH_ID, SANDBOX_APPLICATION_SESSION_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_AGENT_COLLISION_RECOVERY_BINDING_INVALID",
      );
      await expect(client.query(
        "UPDATE memory_review_batches SET recovery_attempts = 3 WHERE id = $1",
        [BATCH_ID],
      )).rejects.toThrow();
      await client.query(
        `UPDATE memory_turn_source_sets SET application_session_id = $2
          WHERE memory_review_batch_id = $1`,
        [BATCH_ID, COLLISION_APPLICATION_SESSION_ID],
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
        last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_IMPLICIT_AGENT_COLLISION",
        recovery_attempts: 3,
        status: "pending",
      }] });
      await expect(client.query(
        `SELECT continuation_token, memory_review_batch_id
           FROM conversation_sessions WHERE id = $1`,
        [COLLISION_APPLICATION_SESSION_ID],
      )).resolves.toMatchObject({ rows: [{
        continuation_token: `retired-memory-review:${COLLISION_APPLICATION_SESSION_ID}`,
        memory_review_batch_id: null,
      }] });
      await expect(client.query(
        `SELECT count(*)::integer AS source_count,
                min(timeline_sequence)::text AS first, max(timeline_sequence)::text AS last
           FROM memory_review_batch_sources WHERE batch_id = $1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ source_count: 50, first: "5540", last: "5589" }] });
      await expect(client.query(
        "SELECT count(*)::integer AS count FROM memory_turn_source_sets WHERE memory_review_batch_id = $1",
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(client.query(
        `SELECT recovery_generation FROM memory_review_owner_alerts
          WHERE batch_id = $1 ORDER BY recovery_generation`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ recovery_generation: 1 }, { recovery_generation: 2 }] });
      await expect(client.query(
        `SELECT metadata FROM audit_events
          WHERE event_type = 'memory_review.operator_recovered' AND subject_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ metadata: {
        collisionEveSessionId: COLLISION_AGENT_SESSION_ID,
        recoveryAttempt: 3,
      } }] });
      await expect(client.query(
        `UPDATE memory_review_batches SET recovery_attempts = 4 WHERE id = $1`,
        [BATCH_ID],
      )).rejects.toThrow();
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query("RESET search_path");
      client.release();
    }
  });
});
