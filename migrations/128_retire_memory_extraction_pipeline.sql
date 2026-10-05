-- The background memory pipeline (extraction, consolidation, thread discovery, LLM briefs) stopped
-- in 059 (v0.12.0) and kept its tables for audit only; no runtime code reads them. They, their
-- triggers and functions go. Thread invalidation keeps advancing the generation, without the brief
-- cache it used to clear.

CREATE OR REPLACE FUNCTION invalidate_memory_threads_for_claim(claim_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  affected uuid[];
BEGIN
  SELECT array_agg(DISTINCT thread_id) INTO affected
  FROM memory_thread_entries WHERE source_claim_id = claim_id;
  IF affected IS NULL THEN RETURN; END IF;
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = ANY(affected)
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
END
$$;

CREATE OR REPLACE FUNCTION invalidate_memory_threads_for_outcome(outcome_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  affected uuid[];
BEGIN
  SELECT array_agg(DISTINCT thread_id) INTO affected
  FROM memory_thread_entries WHERE source_outcome_id = outcome_id;
  IF affected IS NULL THEN RETURN; END IF;
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = ANY(affected)
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
END
$$;

CREATE OR REPLACE FUNCTION invalidate_memory_thread_entry_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected uuid;
BEGIN
  affected := CASE WHEN TG_OP = 'DELETE' THEN OLD.thread_id ELSE NEW.thread_id END;
  UPDATE memory_threads AS thread
  SET generation = generation + 1, updated_at = now()
  WHERE thread.id = affected
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER application_conversations_create_extraction_cursor ON application_conversations;
DROP FUNCTION create_conversation_extraction_cursor();

-- No CASCADE: a dependency outside this list must stop the migration, not disappear with it.
DROP TABLE
  conversation_extraction_cursors,
  memory_consolidation_job_candidates,
  memory_consolidation_jobs,
  memory_sensitive_approval_decisions,
  memory_extraction_approval_notices,
  memory_extraction_candidate_sources,
  memory_extraction_semantic_results,
  memory_extraction_candidates,
  memory_extraction_entry_coverage,
  memory_extraction_gaps,
  memory_extraction_retention_holds,
  memory_extraction_snapshot_entries,
  memory_extraction_ranges,
  memory_extraction_jobs,
  memory_thread_discovery_claim_coverage,
  memory_thread_discovery_existing,
  memory_thread_discovery_sources,
  memory_thread_discovery_jobs,
  memory_thread_brief_block_sources,
  memory_thread_brief_blocks,
  memory_thread_briefs,
  memory_thread_brief_jobs,
  memory_extraction_batches;

DROP FUNCTION
  erase_memory_extraction_after_batch_terminal(),
  erase_memory_extraction_after_candidate_terminal(),
  erase_terminal_memory_extraction_plaintext(uuid),
  validate_memory_thread_discovery_source();
