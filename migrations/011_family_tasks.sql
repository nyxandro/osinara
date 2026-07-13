CREATE TYPE family_task_scope AS ENUM ('personal', 'family');
CREATE TYPE family_task_status AS ENUM ('open', 'completed');

CREATE TABLE family_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope family_task_scope NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  details text CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 2000),
  due_at timestamptz,
  timezone text CHECK (timezone IS NULL OR char_length(timezone) BETWEEN 1 AND 100),
  telegram_chat_id text,
  message_thread_id bigint CHECK (message_thread_id > 0),
  status family_task_status NOT NULL DEFAULT 'open',
  completed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  overdue_notified_at timestamptz,
  overdue_lease_token uuid,
  overdue_lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((due_at IS NULL AND timezone IS NULL) OR (due_at IS NOT NULL AND timezone IS NOT NULL)),
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND owner_user_id = assignee_user_id
      AND group_id IS NULL AND telegram_chat_id IS NULL AND message_thread_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NOT NULL
      AND telegram_chat_id IS NOT NULL)
  ),
  CHECK (
    (status = 'open' AND completed_by_user_id IS NULL AND completed_at IS NULL) OR
    (status = 'completed' AND completed_by_user_id IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (
    (overdue_lease_token IS NULL AND overdue_lease_expires_at IS NULL) OR
    (overdue_lease_token IS NOT NULL AND overdue_lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX family_tasks_personal_idx
  ON family_tasks (family_id, owner_user_id, status, created_at DESC);
CREATE INDEX family_tasks_family_idx
  ON family_tasks (family_id, group_id, status, created_at DESC);
CREATE INDEX family_tasks_overdue_idx
  ON family_tasks (due_at, id)
  WHERE scope = 'family' AND status = 'open' AND overdue_notified_at IS NULL;

CREATE TABLE family_task_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('create', 'update', 'complete', 'delete')),
  input_hash text NOT NULL CHECK (char_length(input_hash) = 64),
  task_id uuid REFERENCES family_tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);
