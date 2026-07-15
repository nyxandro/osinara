CREATE TYPE agent_schedule_scope AS ENUM ('personal', 'family');
CREATE TYPE agent_schedule_status AS ENUM ('active', 'paused', 'leased', 'completed', 'failed');
CREATE TYPE agent_schedule_recurrence_kind AS ENUM ('once', 'daily', 'weekly');
CREATE TYPE agent_schedule_run_status AS ENUM ('claimed', 'dispatching', 'running', 'completed', 'failed', 'ambiguous');

CREATE TABLE agent_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope agent_schedule_scope NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  user_request text NOT NULL CHECK (char_length(user_request) BETWEEN 1 AND 2000),
  scenario_prompt text NOT NULL CHECK (char_length(scenario_prompt) BETWEEN 1 AND 8000),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  recurrence_kind agent_schedule_recurrence_kind NOT NULL,
  recurrence_interval integer NOT NULL CHECK (recurrence_interval BETWEEN 1 AND 365),
  recurrence_days_of_week integer[],
  recurrence_anchor_local timestamp NOT NULL,
  occurrence_index integer NOT NULL DEFAULT 0 CHECK (occurrence_index >= 0),
  next_run_at timestamptz NOT NULL,
  telegram_chat_id text NOT NULL,
  telegram_chat_type text NOT NULL CHECK (telegram_chat_type IN ('group', 'private', 'supergroup')),
  message_thread_id bigint CHECK (message_thread_id > 0),
  status agent_schedule_status NOT NULL DEFAULT 'active',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  dispatch_started_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL AND message_thread_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  ),
  CHECK (
    (recurrence_kind = 'weekly' AND recurrence_days_of_week IS NOT NULL AND cardinality(recurrence_days_of_week) BETWEEN 1 AND 7) OR
    (recurrence_kind <> 'weekly' AND recurrence_days_of_week IS NULL)
  ),
  CHECK (
    recurrence_days_of_week IS NULL OR
    recurrence_days_of_week <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  ),
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL AND dispatch_started_at IS NULL)
  )
);

CREATE INDEX agent_schedules_due_idx
  ON agent_schedules (next_run_at, id)
  WHERE status = 'active';
CREATE INDEX agent_schedules_family_owner_idx
  ON agent_schedules (family_id, owner_user_id, created_at DESC, id DESC);
CREATE INDEX agent_schedules_family_group_idx
  ON agent_schedules (family_id, group_id, created_at DESC, id DESC);

CREATE TABLE agent_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  status agent_schedule_run_status NOT NULL,
  lease_token uuid NOT NULL,
  eve_session_id text,
  application_session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  dispatch_started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX agent_schedule_runs_schedule_created_idx
  ON agent_schedule_runs (schedule_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX agent_schedule_runs_eve_session_idx
  ON agent_schedule_runs (application_session_id, eve_session_id)
  WHERE application_session_id IS NOT NULL AND eve_session_id IS NOT NULL;

CREATE TABLE agent_schedule_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('create', 'update', 'delete', 'run_now')),
  input_hash text NOT NULL CHECK (char_length(input_hash) = 64),
  schedule_id uuid REFERENCES agent_schedules(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);
