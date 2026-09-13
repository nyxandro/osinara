ALTER TABLE memory_review_batches ADD COLUMN recovery_protocol integer NOT NULL DEFAULT 0 CHECK(recovery_protocol IN(0,1));
