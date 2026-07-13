CREATE TABLE telegram_hitl_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  eve_session_id text NOT NULL,
  request_id text NOT NULL,
  telegram_chat_id text NOT NULL,
  telegram_chat_type text NOT NULL CHECK (
    telegram_chat_type IN ('group', 'private', 'supergroup')
  ),
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  telegram_message_thread_id bigint CHECK (telegram_message_thread_id > 0),
  expected_telegram_user_id text NOT NULL,
  callback_data text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  UNIQUE (application_session_id, eve_session_id, request_id),
  UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX telegram_hitl_approvals_session
  ON telegram_hitl_approvals (application_session_id)
  WHERE consumed_at IS NULL;

-- Pre-migration prompts have no durable approver binding and must not remain executable.
UPDATE conversation_sessions
   SET pending_operation = false,
       rotation_requested_at = coalesce(rotation_requested_at, now())
 WHERE pending_operation = true
   AND retired_at IS NULL;
