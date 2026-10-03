/**
 * Memory schema supporting-index integration tests.
 *
 * Construct covered:
 * - Retention, FK cascade, and lifecycle cleanup predicates have child-side PostgreSQL indexes.
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

// These tables are introduced by the unshipped memory migrations 045-050. Every foreign-key
// lookup must have a valid child index whose leading key can serve parent cleanup and retention.
const memoryMigrationTables = [
  "application_conversations",
  "claim_conflicts",
  "claim_evidence",
  "claim_relations",
  "confirmed_outcomes",
  "confirmed_outcome_operations",
  "confirmed_outcome_source_claims",
  "conversation_extraction_cursors",
  "conversation_participants",
  "external_profile_projection_notices",
  "external_profile_projection_policies",
  "external_profile_projection_policy_operations",
  "memory_consolidation_jobs",
  "memory_consolidation_job_candidates",
  "memory_conflict_resolution_operations",
  "memory_extraction_approval_notices",
  "memory_extraction_batches",
  "memory_extraction_candidates",
  "memory_extraction_candidate_sources",
  "memory_extraction_entry_coverage",
  "memory_extraction_jobs",
  "memory_extraction_ranges",
  "memory_extraction_semantic_results",
  "memory_extraction_snapshot_entries",
  "memory_item_refs",
  "memory_items",
  "memory_review_batch_sources",
  "memory_review_batches",
  "memory_review_lanes",
  "memory_projects",
  "memory_sensitive_approval_decisions",
  "memory_thread_briefs",
  "memory_thread_brief_blocks",
  "memory_thread_brief_block_sources",
  "memory_thread_creation_notices",
  "memory_thread_discovery_claim_coverage",
  "memory_thread_discovery_existing",
  "memory_thread_discovery_jobs",
  "memory_thread_discovery_sources",
  "memory_thread_entries",
  "memory_thread_lifecycle_operations",
  "memory_threads",
  "memory_turn_source_sets",
  "memory_turn_sources",
  "profile_subjects",
  "profile_views",
  "profile_view_claims",
  "profile_view_subjects",
] as const;

describeWithDatabase("memory schema supporting indexes", () => {
  afterAll(closeDatabase);

  it("indexes timeline retention and memory cascade references", async () => {
    const indexes = await database().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [[
        "claim_evidence_timeline_entry",
        "confirmed_outcome_source_claims_claim",
        "memory_extraction_snapshot_timeline_entry",
        "memory_items_duplicate_of",
        "memory_items_origin_conversation",
        "memory_items_subject_participant",
        "memory_items_superseded_by",
        "memory_thread_brief_block_sources_entry",
        "memory_thread_discovery_group",
        "memory_turn_source_sets_current_timeline_entry",
        "memory_turn_sources_timeline_entry",
        "memory_threads_completion_outcome",
        "memory_threads_group",
        "profile_view_claims_claim",
        "telegram_group_message_ids_entry_conversation",
      ]],
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      "claim_evidence_timeline_entry",
      "confirmed_outcome_source_claims_claim",
      "memory_extraction_snapshot_timeline_entry",
      "memory_items_duplicate_of",
      "memory_items_origin_conversation",
      "memory_items_subject_participant",
      "memory_items_superseded_by",
      "memory_thread_brief_block_sources_entry",
      "memory_thread_discovery_group",
      "memory_turn_source_sets_current_timeline_entry",
      "memory_turn_sources_timeline_entry",
      "memory_threads_completion_outcome",
      "memory_threads_group",
      "profile_view_claims_claim",
      "telegram_group_message_ids_entry_conversation",
    ].sort());
  });

  it("gives every new memory-table foreign key a leading child index", async () => {
    const missing = await database().query<{ constraint_name: string; table_name: string }>(
      `SELECT relation.relname AS table_name, constraint_row.conname AS constraint_name
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
       WHERE constraint_row.contype = 'f'
         AND relation.relname = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1
           FROM pg_index AS index_row
           WHERE index_row.indrelid = constraint_row.conrelid
             AND index_row.indisvalid
             AND index_row.indisready
             AND index_row.indkey[0] = constraint_row.conkey[1]
         )
       ORDER BY relation.relname, constraint_row.conname`,
      [[...memoryMigrationTables]],
    );

    expect(missing.rows).toEqual([]);
  });
});
