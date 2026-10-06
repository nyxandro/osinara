-- memory_threads.generation versioned the brief cache that 128 removed; nothing reads it. The
-- functions that advanced it keep refreshing updated_at, which orders threads by recency.

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
  SET updated_at = now()
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
  SET updated_at = now()
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
  SET updated_at = now()
  WHERE thread.id = affected
    AND (thread.group_id IS NULL OR EXISTS (
      SELECT 1 FROM telegram_groups WHERE id = thread.group_id
    ));
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE OR REPLACE FUNCTION retract_confirmed_outcome_projections(affected_outcome_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- A missing generated owner group means the outer trust-zone DELETE already owns every root.
  -- Updating those rows mid-cascade could recheck a project FK after its parent was removed.
  IF EXISTS (
    SELECT 1
    FROM confirmed_outcomes AS outcome
    WHERE outcome.id = affected_outcome_id
      AND outcome.group_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM telegram_groups WHERE id = outcome.group_id)
  ) THEN
    RETURN;
  END IF;
  DELETE FROM memory_thread_entries WHERE source_outcome_id = affected_outcome_id;
  UPDATE memory_threads
  SET status = 'active', completion_outcome_id = NULL, completed_at = NULL, updated_at = now()
  WHERE completion_outcome_id = affected_outcome_id;
  UPDATE confirmed_outcomes
  SET status = 'retracted', retracted_at = coalesce(retracted_at, now()), updated_at = now()
  WHERE id = affected_outcome_id AND status = 'confirmed';
END
$$;

ALTER TABLE memory_threads DROP COLUMN generation;
