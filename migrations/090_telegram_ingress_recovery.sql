-- A started dispatch is not replay permission. Bind it before the model can run.
ALTER TABLE telegram_ingress_updates
  ADD COLUMN dispatch_id uuid UNIQUE,
  ADD COLUMN dispatch_session_id text,
  ADD COLUMN dispatch_turn_id text,
  ADD COLUMN dispatch_start_index bigint CHECK (dispatch_start_index >= 0),
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  ADD COLUMN recovery_cancel_requested boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT telegram_ingress_dispatch_binding CHECK (
    (dispatch_session_id IS NULL AND dispatch_turn_id IS NULL AND dispatch_start_index IS NULL) OR
    (dispatch_id IS NOT NULL AND dispatch_session_id IS NOT NULL AND dispatch_turn_id IS NOT NULL
      AND dispatch_start_index IS NOT NULL)
  );

CREATE TABLE runtime_maintenance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  phase text NOT NULL CHECK (phase IN ('ready', 'draining', 'frozen')),
  owner_token uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((phase = 'ready') = (owner_token IS NULL))
);
INSERT INTO runtime_maintenance (phase) VALUES ('ready');

-- A dropped DB connection cannot erase evidence that admitted work may still be executing.
CREATE TABLE runtime_admission_holders (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ordinary', 'callback')),
  eve_session_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_ingress_recovery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  update_id bigint NOT NULL REFERENCES telegram_ingress_updates(update_id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('observe', 'cancel')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
