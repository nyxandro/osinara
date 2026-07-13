CREATE TYPE integration_account_status AS ENUM ('active', 'reauth_required', 'revoked');
CREATE TYPE oauth_authorization_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE calendar_selection_scope AS ENUM ('personal', 'family');

-- Public account metadata is separated from encrypted credential material.
CREATE TABLE integration_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'google_calendar'),
  external_account_id text NOT NULL CHECK (char_length(external_account_id) BETWEEN 1 AND 320),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 320),
  status integration_account_status NOT NULL DEFAULT 'active',
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, provider, external_account_id)
);

CREATE UNIQUE INDEX integration_accounts_one_default
  ON integration_accounts (user_id, provider)
  WHERE is_default AND status <> 'revoked';

CREATE TABLE integration_credentials (
  account_id uuid PRIMARY KEY REFERENCES integration_accounts(id) ON DELETE CASCADE,
  encryption_key_version smallint NOT NULL CHECK (encryption_key_version > 0),
  refresh_token_ciphertext text NOT NULL,
  refresh_token_nonce text NOT NULL,
  refresh_token_auth_tag text NOT NULL,
  access_token_ciphertext text NOT NULL,
  access_token_nonce text NOT NULL,
  access_token_auth_tag text NOT NULL,
  access_token_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only a SHA-256 digest of the browser state token is persisted.
CREATE TABLE oauth_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'google_calendar'),
  state_hash text NOT NULL UNIQUE CHECK (char_length(state_hash) = 64),
  telegram_chat_id text NOT NULL,
  status oauth_authorization_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_authorizations_expiry_idx
  ON oauth_authorizations (expires_at)
  WHERE status IN ('pending', 'processing');

-- Selected calendars are server-authorized destinations, never model-selected account routing.
CREATE TABLE calendar_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  scope calendar_selection_scope NOT NULL,
  integration_account_id uuid NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  calendar_id text NOT NULL CHECK (char_length(calendar_id) BETWEEN 1 AND 1024),
  calendar_summary text NOT NULL CHECK (char_length(calendar_summary) BETWEEN 1 AND 500),
  calendar_timezone text NOT NULL CHECK (char_length(calendar_timezone) BETWEEN 1 AND 100),
  access_role text NOT NULL CHECK (access_role IN ('freeBusyReader', 'reader', 'writer', 'owner')),
  selected_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'personal' AND user_id IS NOT NULL) OR
    (scope = 'family' AND user_id IS NULL AND access_role IN ('writer', 'owner'))
  )
);

CREATE UNIQUE INDEX calendar_selections_personal_unique
  ON calendar_selections (family_id, user_id)
  WHERE scope = 'personal';
CREATE UNIQUE INDEX calendar_selections_family_unique
  ON calendar_selections (family_id)
  WHERE scope = 'family';
