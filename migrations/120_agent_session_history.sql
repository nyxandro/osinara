-- История разговора переезжает из базы Eve в базу приложения: собственное ядро агента хранит её
-- само. Сессия ядра сохраняет идентификатор сессии Eve (`wrun_…`), поэтому все прежние ссылки на
-- него в таблицах приложения остаются верными, а старые строки ничего не теряют.
--
-- agent_session_state — одна строка на сессию ядра:
-- - application_session_id — сессия приложения, которой принадлежит история. Для подагента — та же,
--   что у родителя. Уборка сессий приложения удаляет вместе с ними и историю.
-- - history_generation — текущее поколение истории. Сжатие длинной истории не правит строки, а
--   пишет следующее поколение: пересказ и сохранённый хвост.
-- - compaction_* — последняя известная длина запроса к модели, по ней решается, пора ли сжимать.
-- - announced_skills — набор скиллов, уже объявленный модели в истории; ядро объявляет его снова
--   только при изменении.
-- - source — откуда взялась история: из базы Eve при переезде или создана ядром.
-- - todo — список задач встроенного инструмента `todo`.
-- - read_file_state — отметки встроенного `read_file` по пути файла (длина и хэш прочитанного):
--   `write_file` не перезапишет файл, который модель не читала или который изменился после чтения.
--   Сжатие истории их сбрасывает: прочитанное ушло из контекста.
-- - sandbox_state — с каким набором папок и доступом сессия впервые открыла sandbox. Набор папок
--   сессии не меняется, повторное открытие сверяется с ним.
-- - channel_state — состояние канала разговора: чат, тема, кто начал ход и кнопки подтверждений,
--   которые ещё висят в чате. Счётчик номеров кнопок продолжается после переезда из Eve, иначе
--   старая кнопка в чате совпала бы с новой.
--
-- agent_session_history — сообщения в формате AI SDK по порядку. Тип `json`, а не `jsonb`: он
-- хранит текст как есть, а порядок ключей в аргументах вызова инструмента уходит провайдеру
-- дословно, иначе меняется префикс запроса и пропадает кэш.
CREATE TABLE agent_session_state (
  session_id text PRIMARY KEY CHECK (char_length(session_id) > 0),
  application_session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  parent_session_id text REFERENCES agent_session_state(session_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('runtime', 'eve_import')),
  history_generation integer NOT NULL DEFAULT 0 CHECK (history_generation >= 0),
  compaction_input_tokens integer CHECK (compaction_input_tokens >= 0),
  compaction_prompt_message_count integer CHECK (compaction_prompt_message_count >= 0),
  announced_skills json,
  todo json,
  read_file_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  sandbox_state json,
  channel_state json,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_session_id IS NULL OR parent_session_id <> session_id)
);

CREATE INDEX agent_session_state_application_session ON agent_session_state (application_session_id);
CREATE INDEX agent_session_state_parent_session ON agent_session_state (parent_session_id)
  WHERE parent_session_id IS NOT NULL;

CREATE TABLE agent_session_history (
  session_id text NOT NULL REFERENCES agent_session_state(session_id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation >= 0),
  position integer NOT NULL CHECK (position >= 0),
  turn_id text CHECK (turn_id IS NULL OR char_length(turn_id) > 0),
  message json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, generation, position)
);

-- Адрес разговора в канале (например, чат и тема Telegram) → сессия ядра. Новое сообщение по адресу
-- попадает в его сессию; новый адрес (новый разговор, смена контекста) открывает новую сессию.
-- Перенесённые из Eve сессии получают свои адреса при импорте.
CREATE TABLE agent_continuations (
  channel_kind text NOT NULL CHECK (char_length(channel_kind) > 0),
  token text NOT NULL CHECK (char_length(token) > 0),
  session_id text NOT NULL REFERENCES agent_session_state(session_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_kind, token)
);

CREATE INDEX agent_continuations_session ON agent_continuations (session_id);
