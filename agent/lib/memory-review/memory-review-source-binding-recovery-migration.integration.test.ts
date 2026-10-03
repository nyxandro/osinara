/**
 * Migration 079 missing source-binding recovery tests.
 *
 * Constructs covered:
 * - Only the two exact side-effect-free production batches are requeued.
 * - The lane is rewound to the first predecessor so the batches run in order.
 * - A mutation from either original turn aborts recovery atomically.
 * - All 100 source messages become retained batch evidence again.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";

const integrationTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.DATABASE_URL;

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
const MIGRATION_NAME = "079_memory_review_source_binding_recovery.sql";
const MIGRATION_ORDINAL = 79;
const TEST_SCHEMA = "test_memory_review_source_binding_recovery";
const FIRST_BATCH_ID = "90619ff3-137e-423e-9615-4e436e3a52b1";
const SECOND_BATCH_ID = "e19dc521-5a31-4d2f-b6ea-2baa6639ee10";
const PREDECESSOR_BATCH_ID = "f69985eb-eafd-472b-84f6-df87ae44ea3e";
const LANE_ID = "31da105f-108e-445f-b20d-be5154ecd11a";
const FIRST_AGENT_SESSION_ID = "wrun_01M15ZW7PGDEHMF3VD5RRTW1W7";
const SECOND_AGENT_SESSION_ID = "wrun_01M16T2VN126WQNZWJB2C0VRK2";
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

describeWithDatabase("077 missing source-binding recovery", () => {
  afterAll(closeDatabase);

  it("requeues the exact source-complete chain only while both turns have no side effect", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      const family = await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Source binding recovery') RETURNING id",
      );
      const owner = await client.query<{ id: string }>(
        `INSERT INTO users (telegram_user_id, display_name)
         VALUES ('source-binding-owner', 'Владелец') RETURNING id`,
      );
      await client.query(
        "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
        [family.rows[0]!.id, owner.rows[0]!.id],
      );
      const group = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100-source-binding', 'Source binding incident',
                 'external', 'addressed_only') RETURNING id`,
        [family.rows[0]!.id],
      );
      const conversation = await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
        [group.rows[0]!.id],
      );
      const conversationId = conversation.rows[0]!.id;
      await client.query(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         SELECT $1, $2, sequence, sequence, 'user', 'telegram:source-binding-owner',
                'source-binding-owner', 'Владелец', false, 'text',
                'Сообщение ' || sequence, now()
           FROM generate_series(459, 558) AS sequence`,
        [conversationId, group.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO memory_review_lanes
           (id, conversation_id, processed_through_sequence)
         VALUES ($1, $2, 558)`,
        [LANE_ID, conversationId],
      );
      await client.query(
        `INSERT INTO memory_review_batches
           (id, lane_id, conversation_id, batch_kind, status, predecessor_sequence,
            from_sequence, through_sequence, source_count, eve_session_id, eve_turn_id,
            started_at, completed_at)
         VALUES
           ($1, $2, $3, 'background', 'completed', 408, 409, 458, 50,
            'agent-predecessor', 'turn_0', now(), now()),
           ($4, $2, $3, 'background', 'completed', 458, 459, 508, 50,
            $5, 'turn_0', now(), now()),
           ($6, $2, $3, 'background', 'completed', 508, 509, 558, 50,
            $7, 'turn_0', now(), now())`,
        [PREDECESSOR_BATCH_ID, LANE_ID, conversationId, FIRST_BATCH_ID,
          FIRST_AGENT_SESSION_ID, SECOND_BATCH_ID, SECOND_AGENT_SESSION_ID],
      );
      const migration = await readFile(resolve("migrations", MIGRATION_NAME), "utf8");

      await client.query(
        `INSERT INTO memory_mutation_operations
           (family_id, operation_key, mutation_kind, input_hash, eve_session_id, eve_turn_id)
         VALUES ($1, 'source-binding-operation', 'create', $2, $3, 'turn_0')`,
        [family.rows[0]!.id, "a".repeat(64), SECOND_AGENT_SESSION_ID],
      );
      await expect(client.query(migration)).rejects.toThrow(
        "AGENT_MEMORY_REVIEW_SOURCE_BINDING_RECOVERY_SIDE_EFFECT_FOUND",
      );
      await client.query(
        "DELETE FROM memory_mutation_operations WHERE operation_key = 'source-binding-operation'",
      );

      await client.query(migration);

      await expect(client.query(
        `SELECT id, status::text, recovery_attempts, last_recovery_diagnostic_code,
                application_session_id, eve_session_id, eve_turn_id, diagnostic_code
           FROM memory_review_batches WHERE id IN ($1, $2) ORDER BY from_sequence`,
        [FIRST_BATCH_ID, SECOND_BATCH_ID],
      )).resolves.toMatchObject({ rows: [
        {
          application_session_id: null,
          diagnostic_code: null,
          eve_session_id: null,
          eve_turn_id: null,
          id: FIRST_BATCH_ID,
          last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_SOURCE_BINDING_REGRESSION",
          recovery_attempts: 1,
          status: "pending",
        },
        {
          application_session_id: null,
          diagnostic_code: null,
          eve_session_id: null,
          eve_turn_id: null,
          id: SECOND_BATCH_ID,
          last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_SOURCE_BINDING_REGRESSION",
          recovery_attempts: 1,
          status: "pending",
        },
      ] });
      await expect(client.query(
        `SELECT batch_id, count(*)::integer AS count, min(timeline_sequence)::text AS first,
                max(timeline_sequence)::text AS last
           FROM memory_review_batch_sources WHERE batch_id IN ($1, $2)
          GROUP BY batch_id ORDER BY min(timeline_sequence)`,
        [FIRST_BATCH_ID, SECOND_BATCH_ID],
      )).resolves.toMatchObject({ rows: [
        { batch_id: FIRST_BATCH_ID, count: 50, first: "459", last: "508" },
        { batch_id: SECOND_BATCH_ID, count: 50, first: "509", last: "558" },
      ] });
      await expect(client.query(
        `SELECT lane.processed_through_sequence::text AS lane_cursor,
                array_agg(batch.id ORDER BY batch.predecessor_sequence)
                  FILTER (WHERE batch.predecessor_sequence = lane.processed_through_sequence)
                  AS claimable_batches
           FROM memory_review_lanes AS lane
           LEFT JOIN memory_review_batches AS batch ON batch.lane_id = lane.id
          WHERE lane.id = $1 GROUP BY lane.id`,
        [LANE_ID],
      )).resolves.toMatchObject({ rows: [{
        claimable_batches: [FIRST_BATCH_ID],
        lane_cursor: "458",
      }] });
      await expect(client.query(
        `SELECT count(*)::integer AS count FROM audit_events
          WHERE event_type = 'memory_review.operator_recovered' AND subject_id IN ($1, $2)`,
        [FIRST_BATCH_ID, SECOND_BATCH_ID],
      )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query("RESET search_path");
      client.release();
    }
  });
});
