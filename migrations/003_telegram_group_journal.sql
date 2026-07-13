CREATE TYPE telegram_group_message_mode AS ENUM ('addressed_only', 'all');

ALTER TABLE telegram_groups
  ADD COLUMN message_mode telegram_group_message_mode;

-- Existing groups remain opt-in except for the explicitly approved Sicily chat.
UPDATE telegram_groups
SET message_mode = 'addressed_only';

UPDATE telegram_groups
SET message_mode = 'all'
WHERE telegram_chat_id = '-1003567628736';

ALTER TABLE telegram_groups
  ALTER COLUMN message_mode SET NOT NULL;

CREATE TABLE telegram_group_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  message_thread_id bigint CHECK (message_thread_id > 0),
  telegram_user_id text,
  sender_username text,
  sender_display_name text,
  sender_is_bot boolean NOT NULL,
  message_kind text NOT NULL CHECK (char_length(message_kind) BETWEEN 1 AND 40),
  content_text text,
  reply_to_message_id bigint CHECK (reply_to_message_id > 0),
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, telegram_message_id)
);

CREATE INDEX telegram_group_messages_context
  ON telegram_group_messages (group_id, message_thread_id, telegram_message_id DESC);

CREATE INDEX telegram_group_messages_retention
  ON telegram_group_messages (group_id, telegram_message_id DESC);
