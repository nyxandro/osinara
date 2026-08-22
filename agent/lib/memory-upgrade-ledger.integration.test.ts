/**
 * Production-ledger memory upgrade integration test.
 *
 * Key constructs:
 * - `V0101_LEDGER`: exact production v0.10.1 migration names through release number 048.
 * - `MEMORY_RELEASE_MIGRATIONS`: memory migrations through the main-agent ownership cutover.
 * - `POST_V0101_MIGRATIONS`: every current migration the production-ledger fixture must apply.
 * - `runMigrationRunner`: executes the real migration entrypoint against an isolated test schema.
 * - Upgrade scenario: verifies ledger delta, unique purposes, R0-R7 objects, and review recovery.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;
const TEST_SCHEMA = "test_memory_upgrade_ledger";
const MIGRATION_FILE_PATTERN = /^\d{3}_.+\.sql$/u;
const execFileAsync = promisify(execFile);

const V0101_LEDGER = [
  "001_initial.sql",
  "002_invitations.sql",
  "002_routine_observations.sql",
  "003_telegram_group_journal.sql",
  "004_external_group_tool_policy.sql",
  "005_telegram_durable_ingress.sql",
  "006_hybrid_memory.sql",
  "007_memory_exports.sql",
  "008_e5_memory_embedding_chunks.sql",
  "009_reminders.sql",
  "010_google_calendar_integration.sql",
  "012_task_overdue_and_shopping_lists.sql",
  "013_sessions_and_workspaces.sql",
  "014_workspace_file_deliveries.sql",
  "015_filesystem_first_workspaces.sql",
  "016_remove_workspace_file_tool_allowlists.sql",
  "017_remove_shopping_and_routine_subsystems.sql",
  "018_telegram_hitl_approvals.sql",
  "019_remove_document_parser.sql",
  "020_reject_external_media_ingress.sql",
  "021_tombstone_ignored_telegram_media.sql",
  "022_remove_legacy_group_media_payloads.sql",
  "023_software_updates.sql",
  "024_google_workspace_integration.sql",
  "025_native_gws_workspace_profiles.sql",
  "026_native_gws_workspace_constraints.sql",
  "027_remove_google_workspace_api_proxy_operations.sql",
  "028_remove_tasks.sql",
  "029_agent_schedules.sql",
  "030_proactive_delivery_history.sql",
  "031_lazy_family_attachments.sql",
  "032_normalize_group_journal_forum_topics.sql",
  "033_unified_telegram_group_timeline.sql",
  "034_durable_group_session_context.sql",
  "035_semantic_telegram_approvals.sql",
  "036_agent_timeline_attachments.sql",
  "037_repair_delivered_agent_schedule_runs.sql",
  "038_clear_group_session_cursors_on_retirement.sql",
  "039_external_group_owner_only_mode.sql",
  "040_restrict_owner_only_to_external_groups.sql",
  "041_consolidate_external_group_type.sql",
  "042_canonical_group_task_sessions.sql",
  "043_reply_attachment_source.sql",
  "044_telegram_group_skill_allowlist.sql",
  "045_memory_operation_provenance.sql",
  "046_invitation_delivery_attempts.sql",
  "047_remove_external_web_search_grants.sql",
  "048_oauth_authorization_delivery_state.sql",
] as const;

const MEMORY_RELEASE_MIGRATIONS = [
  "049_opaque_memory_refs.sql",
  "050_russian_memory_retrieval.sql",
  "051_r2a_provenance_extraction_foundation.sql",
  "052_r3_verified_profiles.sql",
  "053_r4_r5_claim_consolidation.sql",
  "054_r6_r7_memory_threads.sql",
  "055_memory_reliability_barriers.sql",
  "056_profile_projection_notice_delivery.sql",
  "057_repair_memory_extraction_sequence_ranges.sql",
  "058_scope_eve_turn_identity.sql",
  "059_main_agent_owned_memory.sql",
  "060_memory_thread_creation_attempts.sql",
  "061_private_memory_thread_notices.sql",
] as const;

const POST_V0101_MIGRATIONS = [
  ...MEMORY_RELEASE_MIGRATIONS,
  "062_external_agent_schedule_scopes.sql",
  "063_external_group_agent_schedules.sql",
  "064_turn_bound_memory_subjects.sql",
  "065_eve_032_session_storage_cutover.sql",
  "066_turn_bound_memory_delta_sources.sql",
  "067_durable_memory_review_batches.sql",
  "068_memory_review_recovery.sql",
  "069_memory_review_sandbox_recovery.sql",
  "070_memory_review_agent_collision_recovery.sql",
  "071_chat_communication_preferences.sql",
  "072_memory_review_local_queue_recovery.sql",
  "073_eve_terminal_stream_retention.sql",
  "074_memory_review_empty_response_recovery.sql",
  "075_telegram_channel_senders.sql",
  "076_image_generation_operations.sql",
] as const;

const EXPECTED_R0_R7_TABLES = [
  "memory_item_refs",
  "application_conversations",
  "claim_evidence",
  "memory_extraction_batches",
  "profile_subjects",
  "profile_views",
  "external_profile_projection_policies",
  "claim_relations",
  "claim_conflicts",
  "memory_consolidation_jobs",
  "memory_projects",
  "memory_threads",
  "memory_thread_entries",
  "memory_turn_source_sets",
  "memory_turn_sources",
  "memory_review_lanes",
  "memory_review_batches",
  "memory_review_batch_sources",
  "memory_review_owner_alerts",
  "memory_thread_briefs",
  "memory_extraction_retention_holds",
  "memory_extraction_gaps",
  "telegram_final_deliveries",
  "memory_thread_brief_jobs",
  "memory_thread_creation_attempts",
] as const;

function testDatabaseUrlForSchema(): string {
  const value = process.env.DATABASE_URL;
  if (!value || !new URL(value).pathname.endsWith("_test")) {
    throw new Error(
      "AGENT_TEST_DATABASE_UNSAFE: Для upgrade integration-теста нужна отдельная БД *_test",
    );
  }

  // PostgreSQL applies this only to the child connection, keeping every DDL statement out of public.
  const url = new URL(value);
  url.searchParams.set("options", `-c search_path=${TEST_SCHEMA},public`);
  return url.toString();
}

async function runMigrationRunner(): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "scripts/migrate.ts"],
    {
      cwd: resolve("."),
      env: { ...process.env, DATABASE_URL: testDatabaseUrlForSchema() },
    },
  );
}

describeWithDatabase("v0.10.1 production ledger upgrade to current memory migrations", () => {
  afterAll(closeDatabase);

  it("applies only the renumbered memory release once and creates the R0-R7 schema", async () => {
    const client = await database().connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);

      // Reconstruct the exact shipped schema and ledger rather than approximating it with fixtures.
      for (const name of V0101_LEDGER) {
        await client.query(await readFile(resolve("migrations", name), "utf8"));
      }
      await client.query(`
        CREATE TABLE schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        "INSERT INTO schema_migrations (name) SELECT unnest($1::text[])",
        [[...V0101_LEDGER]],
      );

      // Filesystem identity is part of the upgrade contract: an old and renamed memory file must not coexist.
      const migrationNames = (await readdir(resolve("migrations")))
        .filter((name) => MIGRATION_FILE_PATTERN.test(name))
        .sort();
      const migrationPurposes = migrationNames.map((name) => name.replace(/^\d{3}_/u, ""));
      expect(new Set(migrationPurposes).size).toBe(migrationPurposes.length);
      expect(migrationNames.filter((name) => name >= "049_" && name < "062_"))
        .toEqual(MEMORY_RELEASE_MIGRATIONS);

      const before = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(before.rows.map(({ name }) => name)).toEqual(V0101_LEDGER);
      const namesBefore = new Set(before.rows.map(({ name }) => name));
      expect(migrationNames.filter((name) => !namesBefore.has(name)))
        .toEqual(POST_V0101_MIGRATIONS);

      await runMigrationRunner();

      // The ledger delta proves the real runner skipped all shipped migrations and applied the rest once.
      const after = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(after.rows.map(({ name }) => name).filter((name) => !namesBefore.has(name)))
        .toEqual(POST_V0101_MIGRATIONS);
      expect(after.rows).toHaveLength(V0101_LEDGER.length + POST_V0101_MIGRATIONS.length);

      // Representative authoritative and projection objects prove every R0-R7 migration took effect.
      for (const table of EXPECTED_R0_R7_TABLES) {
        const object = await client.query<{ relation: string | null }>(
          "SELECT to_regclass($1)::text AS relation",
          [`${TEST_SCHEMA}.${table}`],
        );
        expect(object.rows[0]?.relation).not.toBeNull();
      }
      await expect(client.query(
        `SELECT russian_search_vector FROM memory_items LIMIT 0`,
      )).resolves.toBeDefined();
      await expect(client.query(
        `SELECT delivery_status FROM external_profile_projection_notices LIMIT 0`,
      )).resolves.toBeDefined();
      await expect(client.query(
        `SELECT recovery_attempts, last_recovery_diagnostic_code, last_recovered_at
           FROM memory_review_batches LIMIT 0`,
      )).resolves.toBeDefined();
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
