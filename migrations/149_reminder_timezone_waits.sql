-- Часовой пояс для напоминаний (#451, docs/plans/reminder-timezone.md).
--
-- Настройки помнят, кто поставил пояс: человек своими словами или агент по ясному признаку (город,
-- своя геолокация, запись памяти). Это нужно, чтобы поправка человека сдвигала только напоминания,
-- поставленные под угаданный пояс. До этой миграции пояс ставился только со слов человека, поэтому
-- прежние строки получают 'person', а момент установки — время последнего изменения. Значений по
-- умолчанию у колонок нет: код обязан явно сказать, откуда пояс.
ALTER TABLE user_notification_settings
  ADD COLUMN timezone_source text CHECK (timezone_source IN ('person', 'agent')),
  ADD COLUMN timezone_basis text CHECK (timezone_basis IS NULL OR char_length(timezone_basis) BETWEEN 1 AND 200),
  ADD COLUMN timezone_set_at timestamptz;

UPDATE user_notification_settings SET timezone_source = 'person', timezone_set_at = updated_at;

ALTER TABLE user_notification_settings
  ALTER COLUMN timezone_source SET NOT NULL,
  ALTER COLUMN timezone_set_at SET NOT NULL,
  ADD CONSTRAINT user_notification_settings_agent_basis
    CHECK (timezone_source = 'person' OR timezone_basis IS NOT NULL);

-- Напоминание, названное по часам, когда пояс человека ещё не известен. Часы хранятся так, как их
-- назвал человек, без пояса; напоминание ставится в той же транзакции, где пояс сохраняется. Пока
-- человек молчит, бот сам пишет ему не больше двух раз, затем ожидание снимается без отправки.
CREATE TABLE reminder_timezone_waits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  scope reminder_scope NOT NULL,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  reply_buttons jsonb CHECK (reply_buttons IS NULL OR jsonb_typeof(reply_buttons) = 'array'),
  telegram_chat_id text NOT NULL,
  message_thread_id bigint CHECK (message_thread_id > 0),
  forum_topic_id bigint CHECK (forum_topic_id > 0),
  local_first_run timestamp NOT NULL,
  recurrence_unit reminder_recurrence_unit,
  recurrence_interval integer CHECK (recurrence_interval BETWEEN 1 AND 365),
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'activated', 'missed', 'expired', 'deleted')),
  reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  followups_sent smallint NOT NULL DEFAULT 0 CHECK (followups_sent BETWEEN 0 AND 2),
  next_followup_at timestamptz,
  second_followup_at timestamptz,
  last_followup_message_id text,
  last_followup_button_id uuid,
  last_followup_error_code text CHECK (last_followup_error_code IS NULL OR char_length(last_followup_error_code) BETWEEN 1 AND 100),
  followup_pressed boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, operation_key),
  CHECK (
    (scope = 'personal' AND owner_user_id IS NOT NULL AND group_id IS NULL AND message_thread_id IS NULL) OR
    (scope = 'family' AND owner_user_id IS NULL AND group_id IS NOT NULL)
  ),
  CHECK (
    (recurrence_unit IS NULL AND recurrence_interval IS NULL) OR
    (recurrence_unit IS NOT NULL AND recurrence_interval IS NOT NULL)
  ),
  CHECK ((status = 'waiting') = (resolved_at IS NULL))
);

CREATE INDEX reminder_timezone_waits_followup_idx
  ON reminder_timezone_waits (next_followup_at) WHERE status = 'waiting';
CREATE INDEX reminder_timezone_waits_author_idx
  ON reminder_timezone_waits (family_id, author_user_id, status);

-- Повторное сообщение о поясе видно модели в истории чата, как доставленные напоминания.
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'reminder_timezone_followup';
