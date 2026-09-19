-- A group too quiet to ever reach 50 messages kept its backlog unreviewed indefinitely: the only
-- trigger was the message count, so nothing released the tail. The dispatcher now also releases a
-- short background batch once its oldest source has waited out the configured age, which means
-- "background implies exactly 50 sources" no longer holds.
--
-- The exemption stays explicit instead of becoming a blanket 1..50 allowance. Only a batch that
-- records when the age rule released it may be short, so an accidental short background batch --
-- the mistake the original constraint was built to catch -- still fails to insert.
--
-- Existing rows need no rewrite: every background batch already satisfies one of the other arms,
-- and the new column is NULL for all of them.

ALTER TABLE memory_review_batches
  ADD COLUMN aged_release_at timestamptz;

DO $$
DECLARE
  located text;
  dropped integer := 0;
BEGIN
  FOR located IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'memory_review_batches'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%batch_kind%'
       AND pg_get_constraintdef(oid) LIKE '%source_count%'
  LOOP
    EXECUTE format('ALTER TABLE memory_review_batches DROP CONSTRAINT %I', located);
    dropped := dropped + 1;
  END LOOP;
  IF dropped <> 1 THEN
    RAISE EXCEPTION 'AGENT_MEMORY_REVIEW_AGED_RELEASE_SCHEMA_INVALID: expected one background source-count constraint, found %', dropped;
  END IF;
END $$;

ALTER TABLE memory_review_batches
  ADD CONSTRAINT memory_review_batches_background_source_count CHECK (
    batch_kind <> 'background' OR source_count = 50 OR aged_release_at IS NOT NULL OR (
      recovery_attempts = 1 AND
      last_recovery_diagnostic_code IS NOT DISTINCT FROM
        'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS'
    )
  ),
  ADD CONSTRAINT memory_review_batches_aged_release_kind CHECK (
    aged_release_at IS NULL OR batch_kind = 'background'
  );
