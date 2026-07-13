CREATE TYPE workspace_file_delivery_status AS ENUM ('started', 'completed', 'failed');

CREATE TABLE workspace_file_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  operation_key text NOT NULL UNIQUE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  telegram_chat_id text NOT NULL,
  telegram_message_thread_id bigint,
  presentation text NOT NULL CHECK (presentation IN ('document', 'photo')),
  status workspace_file_delivery_status NOT NULL DEFAULT 'started',
  telegram_message_id text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'completed' AND telegram_message_id IS NOT NULL AND completed_at IS NOT NULL) OR
    (status <> 'completed' AND telegram_message_id IS NULL AND completed_at IS NULL)
  )
);

CREATE INDEX workspace_file_deliveries_file_idx
  ON workspace_file_deliveries (file_id, created_at DESC);
