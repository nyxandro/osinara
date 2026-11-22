/**
 * Migration 158: retirement of the interactive memory-review path (#569).
 *
 * Constructs covered:
 * - A prepared interactive batch whose turn never started becomes a pending background batch over
 *   the same range, released early so it keeps its ordinary retry; the hand-over is audited and its
 *   sources stay where they were.
 * - A batch bound to a started turn, and finished history, are left alone.
 * - A legacy start-ambiguous batch is converted under the retired runtime recovery's integrity
 *   conditions, even while its chat session lives, and kept when its turn may have written memory.
 * - A short background batch without an early release still fails to insert.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { PoolClient } from "pg";
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
const MIGRATION_NAME = "158_retire_interactive_memory_review.sql";
const MIGRATION_ORDINAL = 158;
const TEST_SCHEMA = "test_memory_review_interactive_retirement";
const MIGRATION_NAME_PATTERN = /^(\d+)_.*\.sql$/u;
const RETIRED_CODE = "AGENT_MEMORY_REVIEW_INTERACTIVE_RETIRED";
const LEGACY_CODE = "AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS";

function migrationOrdinal(name: string): number | null {
  const match = MIGRATION_NAME_PATTERN.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function applyEarlierMigrations(client: PoolClient): Promise<void> {
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

interface GroupFixture {
  conversationId: string;
  familyId: string;
  groupId: string;
  laneId: string;
  sessionId: string;
}

/** One family group with messages `firstSequence..lastSequence` and its lane at `cursor`. */
async function createGroup(
  client: PoolClient,
  name: string,
  firstSequence: number,
  lastSequence: number,
  cursor: number,
): Promise<GroupFixture> {
  const family = await client.query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id", [name],
  );
  const familyId = family.rows[0]!.id;
  const owner = await client.query<{ id: string }>(
    "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Владелец') RETURNING id",
    [`${name}-owner`],
  );
  await client.query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, owner.rows[0]!.id],
  );
  const group = await client.query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, 'family_private', 'addressed_only') RETURNING id`,
    [familyId, `-100-${name}`, name],
  );
  const groupId = group.rows[0]!.id;
  const conversation = await client.query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [groupId],
  );
  const conversationId = conversation.rows[0]!.id;
  await client.query(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     SELECT $1, $2, sequence, sequence, 'user', $3, $4, 'Владелец', false, 'text',
            'Сообщение ' || sequence, now()
       FROM generate_series($5::bigint, $6::bigint) AS sequence`,
    [conversationId, groupId, `telegram:${name}-owner`, `${name}-owner`, firstSequence, lastSequence],
  );
  const lane = await client.query<{ id: string }>(
    `INSERT INTO memory_review_lanes (conversation_id, processed_through_sequence)
     VALUES ($1, $2) RETURNING id`,
    [conversationId, cursor],
  );
  const session = await client.query<{ id: string }>(
    `INSERT INTO conversation_sessions
       (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
        continuation_token, started_at, last_activity_at)
     VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', $3, $4, now(), now())
     RETURNING id`,
    [familyId, groupId, `telegram:group:${name}`, `telegram:group:${name}`],
  );
  return { conversationId, familyId, groupId, laneId: lane.rows[0]!.id, sessionId: session.rows[0]!.id };
}

async function insertBatch(
  client: PoolClient,
  group: GroupFixture,
  input: {
    agentSessionId?: string;
    agentTurnId?: string;
    applicationSessionId: string | null;
    diagnosticCode?: string;
    from: number;
    predecessor: number;
    status: "ambiguous" | "completed" | "running";
    through: number;
  },
): Promise<string> {
  const terminal = input.status !== "running";
  const batch = await client.query<{ id: string }>(
    `INSERT INTO memory_review_batches
       (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
        through_sequence, source_count, application_session_id, agent_session_id, agent_turn_id,
        diagnostic_code, started_at, completed_at)
     VALUES ($1, $2, 'interactive', $3::memory_review_batch_status, $4, $5, $6, $7, $8, $9, $10,
             $11, now(), CASE WHEN $12 THEN now() ELSE NULL END)
     RETURNING id`,
    [group.laneId, group.conversationId, input.status, input.predecessor, input.from, input.through,
      input.through - input.from + 1, input.applicationSessionId, input.agentSessionId ?? null,
      input.agentTurnId ?? null, input.diagnosticCode ?? null, terminal],
  );
  const batchId = batch.rows[0]!.id;
  if (input.status !== "completed") {
    await client.query(
      `INSERT INTO memory_review_batch_sources (batch_id, conversation_id, timeline_entry_id, timeline_sequence)
       SELECT $1, message.conversation_id, message.id, message.sequence_id
         FROM telegram_group_messages AS message
        WHERE message.conversation_id = $2 AND message.sequence_id BETWEEN $3 AND $4`,
      [batchId, group.conversationId, input.from, input.through],
    );
  }
  return batchId;
}

async function batchRow(client: PoolClient, batchId: string) {
  const row = await client.query<{
    aged_release: boolean;
    application_session_id: string | null;
    batch_kind: string;
    completed_at: Date | null;
    diagnostic_code: string | null;
    from_sequence: string;
    last_recovery_diagnostic_code: string | null;
    predecessor_sequence: string;
    preparation_entry_id: string | null;
    recovery_attempts: number;
    source_count: number;
    sources: number;
    started_at: Date | null;
    status: string;
    through_sequence: string;
  }>(
    `SELECT batch.batch_kind::text, batch.status::text, batch.application_session_id,
            batch.aged_release_at IS NOT NULL AS aged_release,
            batch.preparation_entry_id, batch.started_at, batch.completed_at, batch.diagnostic_code,
            batch.recovery_attempts, batch.last_recovery_diagnostic_code,
            batch.predecessor_sequence::text, batch.from_sequence::text, batch.through_sequence::text,
            batch.source_count,
            (SELECT count(*)::integer FROM memory_review_batch_sources WHERE batch_id = batch.id) AS sources
       FROM memory_review_batches AS batch WHERE batch.id = $1`,
    [batchId],
  );
  return row.rows[0]!;
}

describeWithDatabase("158 interactive memory review retirement migration", () => {
  afterAll(closeDatabase);

  it("hands unstarted interactive batches to the background review and leaves started ones alone", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      const live = await createGroup(client, "retire-live", 91, 140, 100);
      const finished = await insertBatch(client, live, {
        applicationSessionId: live.sessionId, from: 91, predecessor: 90, status: "completed", through: 100,
      });
      const unstarted = await insertBatch(client, live, {
        applicationSessionId: live.sessionId, from: 101, predecessor: 100, status: "running", through: 112,
      });
      await client.query(
        `UPDATE memory_review_batches SET preparation_entry_id = (
           SELECT id FROM telegram_group_messages WHERE conversation_id = $2 AND sequence_id = 112)
          WHERE id = $1`,
        [unstarted, live.conversationId],
      );
      const bound = await insertBatch(client, live, {
        agentSessionId: "wrun_bound", agentTurnId: "turn_bound", applicationSessionId: live.sessionId,
        from: 113, predecessor: 112, status: "running", through: 120,
      });

      // A pre-2026-09 start ambiguity that the retired runtime recovery would have converted.
      const legacy = await createGroup(client, "retire-legacy", 201, 210, 200);
      // Its chat session still lives: no chat turn can take the batch any more.
      const legacyBatch = await insertBatch(client, legacy, {
        applicationSessionId: legacy.sessionId, diagnosticCode: LEGACY_CODE, from: 201, predecessor: 200,
        status: "ambiguous", through: 210,
      });
      // The same ambiguity, but a turn bound itself to the batch and may have written memory.
      const written = await createGroup(client, "retire-written", 301, 310, 300);
      const writtenBatch = await insertBatch(client, written, {
        applicationSessionId: null, diagnosticCode: LEGACY_CODE, from: 301, predecessor: 300,
        status: "ambiguous", through: 310,
      });
      await client.query(
        `INSERT INTO memory_turn_source_sets
           (agent_session_id, agent_turn_id, application_session_id, conversation_id,
            current_timeline_entry_id, invoking_actor_id, invoking_actor_kind, binding_hash,
            memory_review_batch_id)
         VALUES ('wrun_written', 'turn_written', $1, $2, NULL, 'retire-written-owner',
                 'telegram_user', $3, $4)`,
        [written.sessionId, written.conversationId, "b".repeat(64), writtenBatch],
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      expect(await batchRow(client, unstarted)).toMatchObject({
        aged_release: true,
        application_session_id: null,
        batch_kind: "background",
        completed_at: null,
        diagnostic_code: null,
        from_sequence: "101",
        last_recovery_diagnostic_code: null,
        predecessor_sequence: "100",
        preparation_entry_id: null,
        recovery_attempts: 0,
        source_count: 12,
        sources: 12,
        started_at: null,
        status: "pending",
        through_sequence: "112",
      });
      expect(await batchRow(client, bound)).toMatchObject({
        application_session_id: live.sessionId, batch_kind: "interactive", recovery_attempts: 0,
        sources: 8, status: "running",
      });
      expect(await batchRow(client, finished)).toMatchObject({ batch_kind: "interactive", status: "completed" });
      expect(await batchRow(client, legacyBatch)).toMatchObject({
        aged_release: false, application_session_id: null, batch_kind: "background", completed_at: null,
        diagnostic_code: null, last_recovery_diagnostic_code: LEGACY_CODE, recovery_attempts: 1, sources: 10,
        status: "pending",
      });
      expect(await batchRow(client, writtenBatch)).toMatchObject({
        batch_kind: "interactive", diagnostic_code: LEGACY_CODE, recovery_attempts: 0, status: "ambiguous",
      });

      const audit = await client.query<{ code: string; family_id: string; subject_id: string }>(
        `SELECT family_id, subject_id, metadata->>'diagnosticCode' AS code FROM audit_events
          WHERE event_type = 'memory_review.recovered' ORDER BY metadata->>'diagnosticCode'`,
      );
      expect(audit.rows).toEqual([
        { code: RETIRED_CODE, family_id: live.familyId, subject_id: unstarted },
        { code: LEGACY_CODE, family_id: legacy.familyId, subject_id: legacyBatch },
      ]);

      // The exemption stays explicit: a short background batch that was not released early still fails.
      await expect(client.query(
        `INSERT INTO memory_review_batches
           (lane_id, conversation_id, batch_kind, status, predecessor_sequence, from_sequence,
            through_sequence, source_count)
         VALUES ($1, $2, 'background', 'pending', 120, 121, 130, 10)`,
        [live.laneId, live.conversationId],
      )).rejects.toThrow("memory_review_batches_background_source_count");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      client.release();
    }
  });
});
