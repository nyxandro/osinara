ALTER TABLE memory_review_batches ADD COLUMN infrastructure_recovery_attempts integer NOT NULL DEFAULT 0
  CHECK(infrastructure_recovery_attempts BETWEEN 0 AND 1);
ALTER TABLE memory_review_batches ADD COLUMN preparation_entry_id uuid;
