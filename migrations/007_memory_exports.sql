-- Export delivery is an external side effect. A started marker prevents duplicate documents after a crash.
CREATE TABLE memory_exports (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (family_id, operation_key),
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND failure_code IS NULL) OR
    (status = 'failed' AND completed_at IS NULL AND failure_code IS NOT NULL) OR
    (status = 'started' AND completed_at IS NULL AND failure_code IS NULL)
  )
);
