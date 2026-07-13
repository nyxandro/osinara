CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE family_role AS ENUM ('owner', 'recovery_owner', 'member');
CREATE TYPE telegram_group_type AS ENUM ('family_private', 'external_private', 'external_public');
CREATE TYPE memory_scope AS ENUM ('personal', 'family', 'group');

CREATE TABLE families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  telegram_username text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE family_memberships (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role family_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);

CREATE UNIQUE INDEX one_owner_per_family
  ON family_memberships (family_id)
  WHERE role = 'owner';

CREATE UNIQUE INDEX one_recovery_owner_per_family
  ON family_memberships (family_id)
  WHERE role = 'recovery_owner';

CREATE UNIQUE INDEX one_family_per_user
  ON family_memberships (user_id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_family_created_at
  ON audit_events (family_id, created_at DESC);

CREATE TABLE telegram_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL UNIQUE,
  title text NOT NULL,
  type telegram_group_type NOT NULL,
  tool_allowlist text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bootstrap_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE UNIQUE INDEX one_active_bootstrap_code
  ON bootstrap_codes ((consumed_at IS NULL))
  WHERE consumed_at IS NULL;

CREATE TABLE memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 80),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 4000),
  source text NOT NULL,
  embedding vector(1024),
  embedding_model text,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', value)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NULL) OR
    (scope = 'group' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX memory_personal_key
  ON memory_items (family_id, owner_user_id, key)
  WHERE scope = 'personal';

CREATE UNIQUE INDEX memory_family_key
  ON memory_items (family_id, key)
  WHERE scope = 'family';

CREATE UNIQUE INDEX memory_group_key
  ON memory_items (family_id, group_id, key)
  WHERE scope = 'group';

CREATE INDEX memory_search_vector_idx ON memory_items USING gin (search_vector);
CREATE INDEX memory_embedding_idx ON memory_items USING hnsw (embedding vector_cosine_ops);
