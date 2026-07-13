CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'approved', 'rejected', 'expired')),
  expires_at timestamptz NOT NULL,
  delivery_completed_at timestamptz,
  claimed_at timestamptz,
  claimed_by uuid REFERENCES users(id) ON DELETE CASCADE,
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id) ON DELETE CASCADE,
  decision_operation_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, created_by, operation_key),
  CHECK (
    (status = 'open' AND claimed_at IS NULL AND claimed_by IS NULL
      AND decided_at IS NULL AND decided_by IS NULL) OR
    (status = 'pending' AND claimed_at IS NOT NULL AND claimed_by IS NOT NULL
      AND decided_at IS NULL AND decided_by IS NULL) OR
    (status IN ('approved', 'rejected') AND claimed_at IS NOT NULL AND claimed_by IS NOT NULL
      AND decided_at IS NOT NULL AND decided_by IS NOT NULL) OR
    (status = 'expired' AND decided_at IS NULL AND decided_by IS NULL
      AND (
        (claimed_at IS NULL AND claimed_by IS NULL) OR
        (claimed_at IS NOT NULL AND claimed_by IS NOT NULL)
      ))
  )
);

CREATE INDEX active_invitation_codes
  ON invitations (code_hash, expires_at)
  WHERE status = 'open';

CREATE INDEX pending_family_invitations
  ON invitations (family_id, claimed_at)
  WHERE status = 'pending';

CREATE UNIQUE INDEX one_pending_invitation_per_candidate
  ON invitations (family_id, claimed_by)
  WHERE status = 'pending';

CREATE UNIQUE INDEX invitation_decision_operations
  ON invitations (family_id, decision_operation_key)
  WHERE decision_operation_key IS NOT NULL;
