-- Existing in-flight attempts remain protocol zero until explicitly reconciled.
ALTER TABLE telegram_ingress_updates
  ADD COLUMN recovery_protocol integer NOT NULL DEFAULT 0 CHECK (recovery_protocol IN (0,1)),
  ADD COLUMN preparation_result jsonb,
  ADD COLUMN preparation_completed_at timestamptz,
  ADD COLUMN dispatch_continuation_key text,
  ADD COLUMN dispatch_kind text CHECK (dispatch_kind IN ('send','respond'));

CREATE TABLE telegram_preparation_effects (
  update_id bigint NOT NULL REFERENCES telegram_ingress_updates(update_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  input_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','completed')),
  result jsonb,
  PRIMARY KEY(update_id, ordinal)
);

CREATE TABLE operational_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE CHECK (length(operation_key) BETWEEN 1 AND 500),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 160),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  context jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','delivered','ambiguous','failed')),
  delivery_token uuid,
  delivery_started_at timestamptz,
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_telegram_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operational_incidents_pending ON operational_incidents(created_at,id) WHERE status='pending';

-- Ordinary holders can be reconciled only when the owning backend proves completion.
ALTER TABLE runtime_admission_holders ADD COLUMN owner_instance_id uuid;
