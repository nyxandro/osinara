/**
 * Retired memory pipeline migration integration test.
 *
 * The background extraction pipeline stopped in 059 (v0.12.0) but left its tables, triggers and
 * functions behind. Migration 128 removes them while live memory keeps working:
 * - no table or function of the pipeline is left;
 * - a new conversation is created without its extraction cursor;
 * - a changed thread entry or claim still advances its thread's generation;
 * - claims, threads and entries survive.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const MIGRATION_NAME = "128_retire_memory_extraction_pipeline.sql";
const TEST_SCHEMA = "test_retired_memory_pipeline";

const RETIRED_TABLES = [
  "conversation_extraction_cursors",
  "memory_consolidation_job_candidates",
  "memory_consolidation_jobs",
  "memory_extraction_approval_notices",
  "memory_extraction_batches",
  "memory_extraction_candidate_sources",
  "memory_extraction_candidates",
  "memory_extraction_entry_coverage",
  "memory_extraction_gaps",
  "memory_extraction_jobs",
  "memory_extraction_ranges",
  "memory_extraction_retention_holds",
  "memory_extraction_semantic_results",
  "memory_extraction_snapshot_entries",
  "memory_sensitive_approval_decisions",
  "memory_thread_brief_block_sources",
  "memory_thread_brief_blocks",
  "memory_thread_brief_jobs",
  "memory_thread_briefs",
  "memory_thread_discovery_claim_coverage",
  "memory_thread_discovery_existing",
  "memory_thread_discovery_jobs",
  "memory_thread_discovery_sources",
];

const RETIRED_FUNCTIONS = [
  "create_conversation_extraction_cursor",
  "erase_memory_extraction_after_batch_terminal",
  "erase_memory_extraction_after_candidate_terminal",
  "erase_terminal_memory_extraction_plaintext",
  "validate_memory_thread_discovery_source",
];

async function applyEarlierMigrations(client: import("pg").PoolClient): Promise<void> {
  const names = (await readdir(resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && name < MIGRATION_NAME)
    .sort();
  for (const name of names) {
    await client.query(await readFile(resolve("migrations", name), "utf8"));
  }
}

describeWithDatabase("128 retired memory pipeline migration", () => {
  afterAll(closeDatabase);

  it("removes the pipeline while live memory keeps its threads and invalidation", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await applyEarlierMigrations(client);

      const family = (await client.query<{ id: string }>(
        "INSERT INTO families (name) VALUES ('Migration 128') RETURNING id",
      )).rows[0]!.id;
      const user = (await client.query<{ id: string }>(
        "INSERT INTO users (telegram_user_id, display_name) VALUES ('128001', 'Анна') RETURNING id",
      )).rows[0]!.id;
      await client.query("INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')", [family, user]);
      const group = (await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100128001', 'Семья', 'family_private', 'addressed_only') RETURNING id`,
        [family],
      )).rows[0]!.id;
      const conversation = (await client.query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_group_id = $1", [group],
      )).rows[0]!.id;
      const participant = (await client.query<{ id: string }>(
        `INSERT INTO conversation_participants
           (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
            linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
         VALUES ($1, $2, 'family', $2, '128001', $3, 'Анна', now(), now()) RETURNING id`,
        [conversation, family, user],
      )).rows[0]!.id;
      const message = (await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
         VALUES ($1, $2, 128001, 1, 'user', 'telegram:128001', '128001', 'Анна', false,
                 'text', 'Подготовка к марафону началась', now()) RETURNING id`,
        [conversation, group],
      )).rows[0]!.id;
      const claim = (await client.query<{ id: string }>(
        `INSERT INTO memory_items
           (family_id, author_user_id, scope, kind, content, source, confirmation, sensitivity,
            operation_key, provenance_state, origin_conversation_id, subject_user_id,
            save_approved, content_normalized, profile_eligible)
         VALUES ($1, $2, 'family', 'episode', 'Подготовка к марафону началась', 'agent:test',
                 'model_high', 'normal', 'migration-128-claim', 'evidenced', $3, $2, false,
                 'подготовка к марафону началась', false) RETURNING id`,
        [family, user, conversation],
      )).rows[0]!.id;
      await client.query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, author_user_id, author_label_snapshot, observed_at,
            evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id, source_snapshot)
         VALUES ($1, $2, 'family', $2, 'primary', 'firsthand', $3, 'Семья', $4, $5, $6,
                 'Анна', now(), 'Подготовка к марафону началась', $7, 1, 128001,
                 '{"content":"Подготовка к марафону началась"}'::jsonb)`,
        [claim, family, conversation, group, participant, user, message],
      );
      const thread = (await client.query<{ id: string }>(
        `INSERT INTO memory_threads (family_id, scope, scope_partition_key, subject_user_id, title, purpose)
         VALUES ($1, 'family', $1, $2, 'Марафон', 'Сохранять подготовку') RETURNING id`,
        [family, user],
      )).rows[0]!.id;
      await client.query(
        `INSERT INTO memory_thread_entries
           (thread_id, family_id, scope, scope_partition_key, source_claim_id, role, occurred_at)
         VALUES ($1, $2, 'family', $2, $3, 'goal', now())`,
        [thread, family, claim],
      );

      await client.query(await readFile(resolve("migrations", MIGRATION_NAME), "utf8"));

      expect((await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])",
        [TEST_SCHEMA, RETIRED_TABLES],
      )).rows).toEqual([]);
      expect((await client.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = ANY($2::text[])`,
        [TEST_SCHEMA, RETIRED_FUNCTIONS],
      )).rows).toEqual([]);

      // The cursor trigger is gone with its table, so a new group still gets its conversation.
      const secondGroup = (await client.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
         VALUES ($1, '-100128002', 'Вторая', 'family_private', 'addressed_only') RETURNING id`,
        [family],
      )).rows[0]!.id;
      expect((await client.query(
        "SELECT count(*)::integer AS count FROM application_conversations WHERE telegram_group_id = $1", [secondGroup],
      )).rows).toEqual([{ count: 1 }]);

      const generation = async () => (await client.query<{ generation: number }>(
        "SELECT generation FROM memory_threads WHERE id = $1", [thread],
      )).rows[0]!.generation;
      const before = await generation();
      await client.query("UPDATE memory_thread_entries SET occurred_at = now() - interval '1 day' WHERE thread_id = $1", [thread]);
      expect(await generation()).toBe(before + 1);
      await client.query("UPDATE memory_items SET content = 'Подготовка к марафону идёт' WHERE id = $1", [claim]);
      expect(await generation()).toBe(before + 2);

      expect((await client.query(
        `SELECT
           (SELECT count(*)::integer FROM memory_items WHERE id = $1) AS claims,
           (SELECT count(*)::integer FROM memory_threads WHERE id = $2) AS threads,
           (SELECT count(*)::integer FROM memory_thread_entries WHERE thread_id = $2) AS entries`,
        [claim, thread],
      )).rows).toEqual([{ claims: 1, entries: 1, threads: 1 }]);
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
