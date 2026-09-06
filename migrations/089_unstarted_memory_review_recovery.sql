-- A pre-Eve interactive incident can contain fewer than 50 sources. Replaying that exact range
-- through the existing background queue must not pad it with already-reviewed successor messages.
-- Ordinary background creation still requires 50; only the audited, bounded recovery is exempt.
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
    RAISE EXCEPTION 'AGENT_MEMORY_REVIEW_RECOVERY_SCHEMA_INVALID: expected one background source-count constraint, found %', dropped;
  END IF;
END $$;

ALTER TABLE memory_review_batches
  ADD CONSTRAINT memory_review_batches_background_source_count CHECK (
    batch_kind <> 'background' OR source_count = 50 OR (
      recovery_attempts = 1 AND
      last_recovery_diagnostic_code IS NOT DISTINCT FROM
        'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS'
    )
  );
