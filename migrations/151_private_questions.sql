-- Личные вопросы боту в группах: команда /me (#467, docs/plans/private-questions.md).
--
-- `telegram_private_questions` — источник истины о личном вопросе: кто спросил, в каком чате и теме, что ответил бот
-- и чем кончилось. Повтор вебхука узнаётся по `update_id`; номер личного сообщения Telegram переиспользует после его
-- исчезновения, поэтому ключом он не служит. Запись живёт сутки (`erase_after`) и удаляется вместе с группой.
CREATE TABLE telegram_private_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL CHECK (telegram_chat_id ~ '^-\d+$'),
  message_thread_id integer,
  telegram_user_id text NOT NULL CHECK (char_length(telegram_user_id) BETWEEN 1 AND 32),
  update_id bigint NOT NULL UNIQUE,
  incoming_ephemeral_message_id integer NOT NULL,
  question text NOT NULL,
  received_at timestamptz NOT NULL,
  placeholder_ephemeral_message_id integer,
  placeholder_sent_at timestamptz,
  state text NOT NULL CHECK (state IN (
    'received', 'placeholder_sent', 'answering', 'answered', 'failed', 'cancelled', 'refused', 'window_missed'
  )),
  answer text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  erase_after timestamptz NOT NULL,
  CONSTRAINT telegram_private_questions_placeholder_shape CHECK (
    (placeholder_ephemeral_message_id IS NULL) = (placeholder_sent_at IS NULL)
  ),
  CONSTRAINT telegram_private_questions_answer_shape CHECK (answer IS NULL OR state = 'answered')
);

-- Продолжения подаются в ход по человеку, чату и теме, свежими первыми.
CREATE INDEX telegram_private_questions_recent
  ON telegram_private_questions (group_id, telegram_user_id, received_at DESC);
CREATE INDEX telegram_private_questions_erase_after
  ON telegram_private_questions (erase_after);

-- Меню /me, которое бот поставил в Telegram. Сверка сравнивает желаемое с этой таблицей и снимает лишнее, даже когда
-- группы уже нет в базе: иначе команда осталась бы висеть в чате, где бот не работает.
CREATE TABLE telegram_private_question_command_scopes (
  telegram_chat_id text NOT NULL CHECK (telegram_chat_id ~ '^-\d+$'),
  scope text NOT NULL CHECK (scope IN ('chat', 'chat_member')),
  telegram_user_id text CHECK (char_length(telegram_user_id) BETWEEN 1 AND 32),
  set_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_private_question_command_scopes_shape CHECK (
    (scope = 'chat' AND telegram_user_id IS NULL) OR (scope = 'chat_member' AND telegram_user_id IS NOT NULL)
  ),
  UNIQUE NULLS NOT DISTINCT (telegram_chat_id, scope, telegram_user_id)
);

-- Напоминание, поставленное личным вопросом, приходит в общий чат с отметкой спросившего. Отметку ставит приложение
-- при доставке по этим полям; модель ссылок на пользователей не пишет. Только напоминания чата, не личные.
ALTER TABLE reminders
  ADD COLUMN mention_telegram_user_id text CHECK (char_length(mention_telegram_user_id) BETWEEN 1 AND 32),
  ADD COLUMN mention_name text CHECK (char_length(mention_name) BETWEEN 1 AND 128);

ALTER TABLE reminders
  ADD CONSTRAINT reminders_mention_shape CHECK (
    (mention_telegram_user_id IS NULL AND mention_name IS NULL) OR
    (mention_telegram_user_id IS NOT NULL AND mention_name IS NOT NULL AND scope IN ('group', 'family'))
  );
