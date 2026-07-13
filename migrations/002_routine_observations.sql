CREATE TABLE routine_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL,
  routine_key text NOT NULL CHECK (
    char_length(routine_key) BETWEEN 1 AND 80 AND
    routine_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NULL) OR
    (scope = 'group' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX routine_personal_key
  ON routine_observations (family_id, owner_user_id, routine_key)
  WHERE scope = 'personal';

CREATE UNIQUE INDEX routine_family_key
  ON routine_observations (family_id, routine_key)
  WHERE scope = 'family';

CREATE UNIQUE INDEX routine_group_key
  ON routine_observations (family_id, group_id, routine_key)
  WHERE scope = 'group';

CREATE TABLE routine_observation_events (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 200),
  routine_id uuid NOT NULL REFERENCES routine_observations(id) ON DELETE CASCADE,
  routine_key text NOT NULL,
  scope memory_scope NOT NULL,
  summary text NOT NULL,
  occurrence_count integer NOT NULL CHECK (occurrence_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);
