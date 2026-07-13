CREATE TABLE conversation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation >= 0),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE SET NULL,
  scope memory_scope NOT NULL,
  conversation_key text NOT NULL,
  continuation_token text NOT NULL UNIQUE,
  eve_session_id text UNIQUE,
  started_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  completed_turns integer NOT NULL DEFAULT 0 CHECK (completed_turns >= 0),
  pending_operation boolean NOT NULL DEFAULT false,
  rotation_requested_at timestamptz,
  retired_at timestamptz,
  delete_after timestamptz,
  retention_hold boolean NOT NULL DEFAULT false,
  retention_lease_token uuid,
  retention_lease_expires_at timestamptz,
  cleanup_error_code text,
  UNIQUE (thread_id, generation),
  CHECK (retired_at IS NOT NULL OR (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NOT NULL) OR
    (scope = 'group' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  )),
  CHECK ((retired_at IS NULL AND delete_after IS NULL) OR retired_at IS NOT NULL),
  CHECK ((retention_lease_token IS NULL) = (retention_lease_expires_at IS NULL))
);

CREATE UNIQUE INDEX conversation_sessions_active_thread
  ON conversation_sessions (thread_id)
  WHERE retired_at IS NULL;

CREATE INDEX conversation_sessions_retention_due
  ON conversation_sessions (delete_after)
  WHERE retired_at IS NOT NULL AND retention_hold = false;

CREATE TABLE conversation_session_routes (
  base_continuation_token text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversation_session_routes_session
  ON conversation_session_routes (session_id);

CREATE TABLE conversation_route_generations (
  route_owner text PRIMARY KEY,
  next_generation integer NOT NULL CHECK (next_generation > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION retire_group_conversation_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO conversation_route_generations (route_owner, next_generation)
  SELECT OLD.telegram_chat_id, coalesce(max(generation) + 1, 1)
    FROM conversation_sessions
   WHERE group_id = OLD.id
  ON CONFLICT (route_owner) DO UPDATE
    SET next_generation = greatest(
          conversation_route_generations.next_generation + 1,
          EXCLUDED.next_generation
        ),
        updated_at = now();
  UPDATE conversation_sessions
     SET retired_at = now(),
         delete_after = now() + interval '90 days',
         pending_operation = false
   WHERE group_id = OLD.id AND retired_at IS NULL;
  RETURN OLD;
END;
$$;

CREATE TRIGGER telegram_group_session_retirement
BEFORE DELETE ON telegram_groups
FOR EACH ROW EXECUTE FUNCTION retire_group_conversation_sessions();

CREATE FUNCTION retire_membership_personal_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO conversation_route_generations (route_owner, next_generation)
  SELECT u.telegram_user_id, coalesce(max(s.generation) + 1, 1)
    FROM users u
    LEFT JOIN conversation_sessions s
      ON s.owner_user_id = u.id AND s.scope = 'personal'
   WHERE u.id = OLD.user_id
   GROUP BY u.telegram_user_id
  ON CONFLICT (route_owner) DO UPDATE
    SET next_generation = greatest(
          conversation_route_generations.next_generation + 1,
          EXCLUDED.next_generation
        ),
        updated_at = now();
  UPDATE conversation_sessions
     SET retired_at = now(),
         delete_after = now() + interval '90 days',
         pending_operation = false
   WHERE family_id = OLD.family_id
     AND owner_user_id = OLD.user_id
     AND scope = 'personal'
     AND retired_at IS NULL;
  RETURN OLD;
END;
$$;

CREATE TRIGGER family_membership_session_retirement
BEFORE DELETE ON family_memberships
FOR EACH ROW EXECUTE FUNCTION retire_membership_personal_sessions();

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (family_id, scope, owner_user_id, group_id),
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NULL) OR
    (scope = 'group' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  )
);

CREATE TABLE workspace_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 512),
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  extracted_text text,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', path || ' ' || coalesce(extracted_text, ''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path)
);

CREATE INDEX workspace_files_search_vector_idx
  ON workspace_files USING gin (search_vector);

CREATE TABLE workspace_file_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,
  kind text NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, kind)
);

CREATE TABLE workspace_operations (
  operation_key text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_deletion_jobs (
  workspace_id uuid PRIMARY KEY,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE FUNCTION enqueue_workspace_physical_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_deletion_jobs (workspace_id)
  VALUES (OLD.id)
  ON CONFLICT (workspace_id) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE TRIGGER workspace_physical_deletion
AFTER DELETE ON workspaces
FOR EACH ROW EXECUTE FUNCTION enqueue_workspace_physical_deletion();
