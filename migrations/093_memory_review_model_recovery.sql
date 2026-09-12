ALTER TYPE memory_review_batch_status ADD VALUE 'waiting_model';

-- One observed success per model connection; no chat content or credentials are retained.
CREATE TABLE model_availability (
  route_key text PRIMARY KEY CHECK (route_key ~ '^[0-9a-f]{64}$'),
  success_version bigint NOT NULL CHECK (success_version > 0),
  success_request_id uuid NOT NULL,
  observed_at timestamptz NOT NULL
);

ALTER TABLE memory_review_batches
  ADD COLUMN model_route_key text CHECK (model_route_key ~ '^[0-9a-f]{64}$'),
  ADD COLUMN model_recovery_generation integer NOT NULL DEFAULT 0 CHECK (model_recovery_generation >= 0),
  ADD COLUMN waiting_since timestamptz,
  ADD COLUMN waiting_success_version bigint CHECK (waiting_success_version >= 0),
  ADD CONSTRAINT memory_review_model_wait_shape CHECK (
    (status::text = 'waiting_model' AND batch_kind = 'background' AND model_route_key IS NOT NULL
      AND waiting_since IS NOT NULL AND waiting_success_version IS NOT NULL
      AND diagnostic_code IS NOT NULL AND eve_session_id IS NOT NULL AND eve_turn_id IS NOT NULL)
    OR (status::text <> 'waiting_model' AND waiting_since IS NULL AND waiting_success_version IS NULL)
  );
CREATE INDEX memory_review_batches_waiting_model ON memory_review_batches (model_route_key, waiting_since)
  WHERE waiting_since IS NOT NULL;

-- A new model recovery attempt is independent of the old, bounded pre-handoff repair counter.
ALTER TABLE memory_review_owner_alerts
  ADD COLUMN model_recovery_generation integer NOT NULL DEFAULT 0 CHECK (model_recovery_generation >= 0),
  ADD COLUMN notification_kind text NOT NULL DEFAULT 'blocked' CHECK (notification_kind IN ('blocked', 'waiting_model', 'partial')),
  DROP CONSTRAINT memory_review_owner_alerts_batch_generation_key,
  ADD CONSTRAINT memory_review_owner_alerts_attempt_unique
    UNIQUE (batch_id, recovery_generation, model_recovery_generation, notification_kind);
