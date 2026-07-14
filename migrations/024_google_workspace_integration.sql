-- Calendar-only grants cannot authorize the broader Workspace surface and must not be reused.
DELETE FROM oauth_authorizations WHERE provider = 'google_calendar';
DELETE FROM integration_accounts WHERE provider = 'google_calendar';

-- Calendar selections belonged to the abandoned application-specific API path.
DROP TABLE calendar_selections;
DROP TYPE calendar_selection_scope;

ALTER TABLE integration_accounts
  DROP CONSTRAINT integration_accounts_provider_check;
ALTER TABLE integration_accounts
  ADD CONSTRAINT integration_accounts_provider_check
  CHECK (provider = 'google_workspace');

ALTER TABLE oauth_authorizations
  DROP CONSTRAINT oauth_authorizations_provider_check;
ALTER TABLE oauth_authorizations
  ADD CONSTRAINT oauth_authorizations_provider_check
  CHECK (provider = 'google_workspace');

-- Durable mutation markers prevent Eve replay from duplicating ambiguous Google side effects.
CREATE TABLE integration_operations (
  operation_key text PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'google_workspace'),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  status text NOT NULL CHECK (status IN ('started', 'completed')),
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'started' AND result IS NULL AND completed_at IS NULL) OR
    (status = 'completed' AND result IS NOT NULL AND completed_at IS NOT NULL)
  )
);
