CREATE TYPE reminder_scope AS ENUM ('personal', 'family');
CREATE TYPE reminder_status AS ENUM ('active', 'paused', 'leased', 'completed', 'failed');
CREATE TYPE reminder_recurrence_unit AS ENUM ('daily', 'weekly', 'monthly');

-- Notification settings are required data: reminder creation fails until the user selects them.
CREATE TABLE user_notification_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  quiet_start time,
  quiet_end time,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (quiet_start IS NULL AND quiet_end IS NULL) OR
    (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start <> quiet_end)
  )
);

-- A task owns one current occurrence; recurrence is anchored to local wall-clock time for DST safety.
CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope reminder_scope NOT NULL,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  telegram_chat_id text NOT NULL,
  message_thread_id bigint CHECK (message_thread_id > 0),
  recurrence_unit reminder_recurrence_unit,
  recurrence_interval integer CHECK (recurrence_interval BETWEEN 1 AND 365),
  recurrence_anchor_local timestamp NOT NULL,
  occurrence_index integer NOT NULL DEFAULT 0 CHECK (occurrence_index >= 0),
  due_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  delayed_by_quiet_hours boolean NOT NULL DEFAULT false,
  status reminder_status NOT NULL DEFAULT 'active',
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
    (recurrence_unit IS NULL AND recurrence_interval IS NULL) OR
    (recurrence_unit IS NOT NULL AND recurrence_interval IS NOT NULL)
  ),
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL AND dispatch_started_at IS NULL)
  )
);

CREATE INDEX reminders_due_idx
  ON reminders (available_at, id)
  WHERE status = 'active';
CREATE INDEX reminders_family_owner_idx
  ON reminders (family_id, owner_user_id, created_at DESC, id DESC);
CREATE INDEX reminders_family_group_idx
  ON reminders (family_id, group_id, created_at DESC, id DESC);

-- Replay markers survive task deletion so a resumed Eve step cannot recreate a reminder.
CREATE TABLE reminder_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('create', 'update', 'delete')),
  input_hash text NOT NULL CHECK (char_length(input_hash) = 64),
  reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);
