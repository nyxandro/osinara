-- The development-era key/value memory has no trustworthy author or confirmation metadata.
-- Product policy explicitly requires a clean cut, so old memory and behavior preferences are removed.
TRUNCATE memory_items;

DROP INDEX memory_personal_key;
DROP INDEX memory_family_key;
DROP INDEX memory_group_key;
DROP INDEX memory_search_vector_idx;
DROP INDEX memory_embedding_idx;

CREATE TYPE memory_kind AS ENUM ('profile', 'preference', 'fact', 'episode', 'family_shared');
CREATE TYPE memory_confirmation AS ENUM ('model_high', 'user_confirmed');
CREATE TYPE memory_sensitivity AS ENUM ('normal', 'sensitive');
CREATE TYPE memory_embedding_status AS ENUM ('pending', 'indexed', 'failed');

ALTER TABLE memory_items DROP COLUMN key;
ALTER TABLE memory_items RENAME COLUMN value TO content;

ALTER TABLE memory_items
  ADD COLUMN author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN author_telegram_user_id text,
  ADD COLUMN kind memory_kind NOT NULL,
  ADD COLUMN confirmation memory_confirmation NOT NULL,
  ADD COLUMN sensitivity memory_sensitivity NOT NULL,
  ADD COLUMN source_event_id text,
  ADD COLUMN message_thread_id text,
  ADD COLUMN operation_key text NOT NULL,
  ADD COLUMN embedding_status memory_embedding_status NOT NULL DEFAULT 'pending',
  ADD CONSTRAINT memory_personal_author_check CHECK (
    scope <> 'personal' OR author_user_id = owner_user_id
  ),
  ADD CONSTRAINT memory_group_author_check CHECK (
    scope <> 'group' OR author_telegram_user_id IS NOT NULL
  ),
  ADD CONSTRAINT memory_operation_key_unique UNIQUE (family_id, operation_key);

-- Search indexes remain global physically, while every query applies tenant and owner/group predicates first.
CREATE INDEX memory_items_scope_owner_updated
  ON memory_items (family_id, scope, owner_user_id, updated_at DESC, id DESC);
CREATE INDEX memory_items_scope_group_updated
  ON memory_items (family_id, scope, group_id, updated_at DESC, id DESC);
CREATE INDEX memory_search_vector_idx ON memory_items USING gin (search_vector);
CREATE INDEX memory_embedding_idx ON memory_items USING hnsw (embedding vector_cosine_ops);

-- Mutation operations survive item deletion so Eve replay cannot recreate a deleted memory.
CREATE TABLE memory_mutation_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  mutation_kind text NOT NULL CHECK (mutation_kind IN ('create', 'update', 'delete')),
  input_hash text NOT NULL CHECK (char_length(input_hash) = 64),
  memory_item_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);

-- One durable indexing job exists per memory item; updates reset the same job to pending.
CREATE TABLE memory_embedding_jobs (
  memory_item_id uuid PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX memory_embedding_jobs_claim
  ON memory_embedding_jobs (status, lease_expires_at, updated_at);

-- Presentation preferences are trusted typed settings, not semantic long-term memories.
CREATE TABLE behavior_preferences (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  preference text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NULL) OR
    (scope = 'group' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX behavior_preferences_personal
  ON behavior_preferences (family_id, owner_user_id, preference)
  WHERE scope = 'personal';
CREATE UNIQUE INDEX behavior_preferences_family
  ON behavior_preferences (family_id, preference)
  WHERE scope = 'family';
CREATE UNIQUE INDEX behavior_preferences_group
  ON behavior_preferences (family_id, group_id, preference)
  WHERE scope = 'group';
