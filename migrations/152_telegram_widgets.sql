-- Виджеты Telegram, которые агент собрал по протоколу A2UI (#468), и нажатия в них.
--
-- Вёрстка виджета после отправки не меняется (правило Telegram), поэтому здесь хранится то, что
-- нужно позже: описание виджета и его текущие данные — чтобы агент обновил показанные значения;
-- список действий и отметок — чтобы понять нажатие, ведь данные нажатия присылает клиент и в них
-- только номер действия и биты отметок. Своё HTML-виджет (игра) здесь не хранится: с ботом он не
-- связан.
CREATE TABLE telegram_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id text NOT NULL CHECK (char_length(telegram_chat_id) BETWEEN 1 AND 32),
  telegram_message_id bigint NOT NULL CHECK (telegram_message_id > 0),
  -- surfaceId из описания A2UI: по нему агент обновляет виджет; в одном чате не повторяется.
  surface_id text NOT NULL CHECK (surface_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  agent_session_id text NOT NULL,
  agent_turn_id text NOT NULL,
  caption text NOT NULL CHECK (char_length(caption) BETWEEN 1 AND 300),
  -- Детали, исходные данные, действия, отметки, привязки и неизменяемые чтения — как их записал сборщик.
  surface jsonb NOT NULL CHECK (jsonb_typeof(surface) = 'object'),
  data_model jsonb NOT NULL CHECK (jsonb_typeof(data_model) = 'object'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (telegram_chat_id, telegram_message_id),
  UNIQUE (telegram_chat_id, surface_id)
);

-- Нажатия, пришедшие с бета-сервера Telegram. Номер обновления беты — своя нумерация, поэтому он
-- хранится здесь, а в очередь чата нажатие встаёт сообщением нажавшего со своим номером обновления.
-- accepted — принято и стоит в очереди (или уже обработано); refused_* — отказано с ответом виджету.
CREATE TABLE telegram_widget_queries (
  -- Нажатие узнаётся по номеру запроса Telegram: повторная доставка приносит тот же номер.
  widget_query_id text PRIMARY KEY CHECK (char_length(widget_query_id) BETWEEN 1 AND 128),
  beta_update_id bigint NOT NULL UNIQUE CHECK (beta_update_id > 0),
  widget_id uuid REFERENCES telegram_widgets (id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]*$'),
  action_index integer CHECK (action_index >= 0),
  revision integer CHECK (revision >= 0),
  status text NOT NULL CHECK (status IN ('accepted', 'refused_busy', 'refused_closed', 'refused_invalid')),
  -- Номер обновления, под которым сообщение нажавшего встало в очередь чата.
  ingress_update_id bigint UNIQUE,
  -- Сообщение нажавшего, собранное один раз: повторная доставка ставит в очередь ровно его.
  message_payload jsonb CHECK (message_payload IS NULL OR jsonb_typeof(message_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_widget_queries_accepted_shape CHECK (
    status <> 'accepted' OR (widget_id IS NOT NULL AND action_index IS NOT NULL AND revision IS NOT NULL AND ingress_update_id IS NOT NULL)
  )
);

CREATE INDEX telegram_widget_queries_widget_user
  ON telegram_widget_queries (widget_id, telegram_user_id) WHERE status = 'accepted';
