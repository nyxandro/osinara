-- Кнопки-ответы под сообщением бота. Агент прикладывает их к своему итоговому ответу хода, а
-- напоминание несёт их с собой. Нажатие становится обычным сообщением адресата в той же очереди
-- чата: оно весит ровно как напечатанный ответ и ничего не подтверждает.
--
-- Жизнь набора: staged — записан, сообщение ещё не отправлено (или отправлено, но номер ещё не
-- сохранён); active — кнопки видны; selected — адресат нажал одну из них; dismissed — адресат написал
-- что-то своё, кнопки убраны с подписью «Ничего не выбрано».
-- В кнопке лежит только token и номер варианта: подписи и адресат берутся отсюда, потому что
-- callback_data присылает клиент и ей нельзя доверять.
CREATE TABLE telegram_reply_button_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{22}$'),
  origin text NOT NULL CHECK (origin IN ('turn', 'reminder')),
  agent_session_id text,
  agent_turn_id text,
  reminder_id uuid REFERENCES reminders (id) ON DELETE SET NULL,
  telegram_chat_id text NOT NULL CHECK (char_length(telegram_chat_id) BETWEEN 1 AND 32),
  telegram_chat_type text NOT NULL CHECK (telegram_chat_type IN ('private', 'group', 'supergroup')),
  addressee_telegram_user_id text NOT NULL CHECK (addressee_telegram_user_id ~ '^[1-9][0-9]*$'),
  buttons jsonb NOT NULL CHECK (jsonb_typeof(buttons) = 'array'),
  status text NOT NULL CHECK (status IN ('staged', 'active', 'selected', 'dismissed')),
  telegram_message_id bigint CHECK (telegram_message_id > 0),
  message_text text CHECK (char_length(message_text) >= 1),
  message_format text CHECK (message_format IN ('plain', 'rich')),
  -- Сущности форматирования обычного сообщения (жирный заголовок напоминания), чтобы подпись после
  -- выбора не стёрла их при правке текста.
  message_entities jsonb CHECK (message_entities IS NULL OR jsonb_typeof(message_entities) = 'array'),
  activated_at timestamptz,
  selected_index integer CHECK (selected_index >= 0),
  selected_by_telegram_user_id text,
  callback_query_id text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_reply_button_sets_origin_shape CHECK (
    (origin = 'turn' AND agent_session_id IS NOT NULL AND agent_turn_id IS NOT NULL)
    OR (origin = 'reminder' AND agent_session_id IS NULL AND agent_turn_id IS NULL)
  ),
  CONSTRAINT telegram_reply_button_sets_message_shape CHECK (
    (message_text IS NULL) = (message_format IS NULL)
    AND (message_entities IS NULL OR message_format = 'plain')
  ),
  CONSTRAINT telegram_reply_button_sets_status_shape CHECK (
    (status = 'staged' AND resolved_at IS NULL AND selected_index IS NULL)
    OR (status = 'active' AND telegram_message_id IS NOT NULL AND message_text IS NOT NULL
      AND activated_at IS NOT NULL AND resolved_at IS NULL AND selected_index IS NULL)
    OR (status = 'selected' AND telegram_message_id IS NOT NULL AND message_text IS NOT NULL
      AND resolved_at IS NOT NULL AND selected_index IS NOT NULL
      AND selected_by_telegram_user_id IS NOT NULL AND callback_query_id IS NOT NULL)
    OR (status = 'dismissed' AND telegram_message_id IS NOT NULL AND resolved_at IS NOT NULL
      AND selected_index IS NULL)
  )
);

-- Один набор на ход: повторный вызов инструмента заменяет кнопки, а не добавляет вторые.
CREATE UNIQUE INDEX telegram_reply_button_sets_staged_turn
  ON telegram_reply_button_sets (agent_turn_id) WHERE status = 'staged';

-- Новое сообщение адресата убирает все его видимые кнопки в этом чате.
CREATE INDEX telegram_reply_button_sets_active_addressee
  ON telegram_reply_button_sets (telegram_chat_id, addressee_telegram_user_id) WHERE status = 'active';

-- Кнопки напоминания: те же ряды, что у агента, приходят с каждой доставкой.
ALTER TABLE reminders
  ADD COLUMN reply_buttons jsonb CHECK (reply_buttons IS NULL OR jsonb_typeof(reply_buttons) = 'array');
