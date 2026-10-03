/**
 * Migration 068 memory-review recovery integration tests.
 *
 * Constructs covered:
 * - A retained, side-effect-free ambiguous background turn is rebuilt and requeued once.
 * - Any matching durable memory operation prevents automatic recovery.
 * - The discarded application root remains retired and auditable but cannot be resumed.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const MIGRATION_NAME = "068_memory_review_recovery.sql";
const TEST_SCHEMA = "test_memory_review_recovery_migration";

async function applyMigrationsBefore068(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

async function insertAmbiguousBatch(
  client: import("pg").PoolClient,
  input: {
    conversationId: string;
    familyId: string;
    groupId: string;
    messageThreadId: number | null;
    sequenceStart: number;
    operationTurnId: string | null;
  },
): Promise<{ batchId: string; sessionId: string }> {
  const sequenceEnd = input.sequenceStart + 49;
  await client.query(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text,
        message_thread_id, sent_at)
     SELECT $1, $2, sequence, sequence, 'user', 'telegram:recovery-owner',
            'recovery-owner', 'Владелец', false, 'text', 'Сообщение ' || sequence,
            $3, now()
       FROM generate_series($4::integer, $5::integer) AS sequence`,
    [input.conversationId, input.groupId, input.messageThreadId,
      input.sequenceStart, sequenceEnd],
  );
  const lane = await client.query<{ id: string }>(
    `INSERT INTO memory_review_lanes
       (conversation_id, message_thread_id, processed_through_sequence)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.conversationId, input.messageThreadId, input.sequenceStart - 1],
  );
  const batch = await client.query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
        through_sequence, source_count, eve_session_id, eve_turn_id, diagnostic_code,
        started_at, completed_at)
     VALUES ($1, $2, 'background', 'ambiguous', $3, $4, $5, 50,
             $6, $7, 'AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS', now(), now())
     RETURNING id`,
    [lane.rows[0]!.id, input.conversationId, input.sequenceStart - 1,
      input.sequenceStart, sequenceEnd, `agent-recovery-${input.sequenceStart}`,
      `turn-recovery-${input.sequenceStart}`],
  );
  const session = await client.query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, task_state,
        conversation_key, continuation_token, eve_session_id, started_at, last_activity_at,
        retired_at, delete_after, memory_review_batch_id)
     VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'proactive', 'failed',
             $3, $3, $4, now(), now(), now(), now() + interval '90 days', $5)
     RETURNING id`,
    [input.familyId, input.groupId, `memory-review:${batch.rows[0]!.id}`,
      `agent-recovery-${input.sequenceStart}`, batch.rows[0]!.id],
  );
  await client.query(
    "UPDATE memory_review_batches SET application_session_id = $2 WHERE id = $1",
    [batch.rows[0]!.id, session.rows[0]!.id],
  );

  // A system-owned operation proves that the old turn crossed the side-effect boundary.
  if (input.operationTurnId) {
    await client.query(
      `INSERT INTO memory_mutation_operations
         (family_id, operation_key, mutation_kind, input_hash, actor_user_id,
          actor_telegram_user_id, eve_session_id, eve_turn_id)
       VALUES ($1, $2, 'create', $3, NULL, NULL, $4, $5)`,
      [input.familyId, `recovery-operation-${input.sequenceStart}`, "a".repeat(64),
        `agent-recovery-${input.sequenceStart}`, input.operationTurnId],
    );
  }
  return { batchId: batch.rows[0]!.id, sessionId: session.rows[0]!.id };
}

describeWithDatabase("068 memory review recovery migration", () => {
  afterAll(closeDatabase);

  it("requeues only a side-effect-free retained source range", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyMigrationsBefore068(client);

      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Memory review recovery') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('recovery-owner', 'Владелец') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-recovery', 'Recovery group', 'family_private', 'addressed_only')
         RETURNING id`,
        [family.rows[0]!.id],
      );
      const conversation = await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
        [group.rows[0]!.id],
      );
      const recoverable = await insertAmbiguousBatch(client, {
        conversationId: conversation.rows[0]!.id,
        familyId: family.rows[0]!.id,
        groupId: group.rows[0]!.id,
        messageThreadId: null,
        sequenceStart: 5540,
        operationTurnId: null,
      });
      const unsafe = await insertAmbiguousBatch(client, {
        conversationId: conversation.rows[0]!.id,
        familyId: family.rows[0]!.id,
        groupId: group.rows[0]!.id,
        messageThreadId: 42,
        sequenceStart: 6000,
        operationTurnId: "turn-from-another-root-step",
      });

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      await expect(client.query(
        `SELECT batch.status::text, batch.recovery_attempts,
                batch.last_recovery_diagnostic_code,
                batch.application_session_id,
                count(source.timeline_entry_id)::integer AS source_count
           FROM memory_review_batches AS batch
           LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
          WHERE batch.id = $1 GROUP BY batch.id`,
        [recoverable.batchId],
      )).resolves.toMatchObject({ rows: [{
        application_session_id: null,
        last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
        recovery_attempts: 1,
        source_count: 50,
        status: "pending",
      }] });
      await expect(client.query(
        `SELECT continuation_token, memory_review_batch_id
           FROM conversation_sessions WHERE id = $1`,
        [recoverable.sessionId],
      )).resolves.toMatchObject({ rows: [{
        continuation_token: `retired-memory-review:${recoverable.sessionId}`,
        memory_review_batch_id: null,
      }] });
      await expect(client.query(
        `SELECT count(*)::integer AS count FROM audit_events
          WHERE event_type = 'memory_review.recovered' AND subject_id = $1`,
        [recoverable.batchId],
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(client.query(
        "SELECT status::text, recovery_attempts FROM memory_review_batches WHERE id = $1",
        [unsafe.batchId],
      )).resolves.toMatchObject({ rows: [{ recovery_attempts: 0, status: "ambiguous" }] });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
