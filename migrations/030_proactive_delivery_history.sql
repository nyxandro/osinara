CREATE TYPE proactive_delivery_scope AS ENUM ('personal', 'family');
CREATE TYPE proactive_delivery_source_kind AS ENUM ('agent_schedule', 'reminder');

ALTER TABLE conversation_sessions
  ADD COLUMN last_proactive_delivery_id bigint NOT NULL DEFAULT 0
  CHECK (last_proactive_delivery_id >= 0);

-- Successful proactive Telegram messages remain application-owned across Eve session rotation.
CREATE TABLE proactive_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope proactive_delivery_scope NOT NULL,
  source_kind proactive_delivery_source_kind NOT NULL,
  source_id uuid NOT NULL,
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  content_text text NOT NULL CHECK (char_length(content_text) BETWEEN 1 AND 100000),
  scheduled_for timestamptz NOT NULL,
  delivered_at timestamptz NOT NULL,
  telegram_chat_id text NOT NULL CHECK (char_length(telegram_chat_id) > 0),
  message_thread_id bigint CHECK (message_thread_id > 0),
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('russian', coalesce(title, '') || ' ' || content_text)
  ) STORED,
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL AND message_thread_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  ),
  UNIQUE (source_kind, source_id, telegram_message_id)
);

CREATE INDEX proactive_deliveries_personal_context_idx
  ON proactive_deliveries (family_id, owner_user_id, telegram_chat_id, id DESC)
  WHERE scope = 'personal';
CREATE INDEX proactive_deliveries_family_context_idx
  ON proactive_deliveries (family_id, group_id, telegram_chat_id, message_thread_id, id DESC)
  WHERE scope = 'family';
CREATE INDEX proactive_deliveries_search_idx
  ON proactive_deliveries USING gin (search_vector);
