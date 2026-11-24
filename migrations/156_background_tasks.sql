-- Фоновые задачи (#519).
--
-- Долгую самостоятельную работу основной агент уводит из разговора: задача идёт отдельным ходом в своей сессии,
-- чат свободен, итог приходит событием, и основной агент пересказывает его. До трёх задач одновременно на весь
-- бот, до часа работы и 100 шагов на задачу; только личные чаты и семейные группы.

-- Сессия задачи — свой вид: выкатка не считает её занятостью, а сессии сценариев и разбора памяти остаются
-- своими. Новое значение в этой же миграции не используется: так его можно добавить внутри транзакции.
ALTER TYPE conversation_session_kind ADD VALUE 'background';

ALTER TABLE agent_turns DROP CONSTRAINT agent_turns_kind_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_kind_check
  CHECK (kind IN ('conversation', 'scheduled', 'wakeup', 'memory_review', 'subagent', 'background'));

-- Номер задачи короткий: его называет человек («как там задача 7?»), а модель передаёт в инструмент.
CREATE TABLE background_tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  -- Как в telegram_groups и application_conversations: номер чата хранится текстом.
  telegram_chat_id text NOT NULL CHECK (telegram_chat_id ~ '^-?[1-9][0-9]{0,19}$'),
  telegram_chat_type text NOT NULL CHECK (telegram_chat_type IN ('private', 'group', 'supergroup')),
  forum_topic_id bigint CHECK (forum_topic_id IS NULL OR forum_topic_id > 0),
  message_thread_id bigint CHECK (message_thread_id IS NULL OR message_thread_id > 0),
  -- Песочница чата, где задачу запустили: задача видит файлы, которые человек прислал в этот разговор.
  sandbox_session_id text NOT NULL,
  -- Очередь чата, из сообщения которого задачу запустили: событие задачи ждёт за сообщениями людей в ней.
  ingress_queue_id uuid REFERENCES telegram_ingress_queues(id) ON DELETE SET NULL,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  task text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 12000),
  state text NOT NULL CHECK (state IN (
    'queued', 'running', 'waiting_answer', 'stopping',
    'finished', 'failed', 'limit_time', 'limit_steps', 'stopped', 'unanswered', 'reported'
  )),
  -- Сессия задачи живёт, пока задача не закончилась; журнал её хода стирается вместе с ней.
  application_session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  agent_session_id text,
  current_turn_id text,
  -- Часы задачи идут только пока её ход работает: очередь, ожидание ответа и перезапуск в них не входят.
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  running_since timestamptz,
  steps integer NOT NULL DEFAULT 0 CHECK (steps >= 0),
  last_step_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  waiting_question text CHECK (waiting_question IS NULL OR char_length(waiting_question) BETWEEN 1 AND 1000),
  waiting_since timestamptz,
  question_seq integer NOT NULL DEFAULT 0 CHECK (question_seq >= 0),
  stop_requested_at timestamptz,
  -- Почему задачу оборвали: записывается до хода-сводки, чтобы после перезапуска сводка закончилась с той же причиной.
  summary_reason text CHECK (summary_reason IS NULL OR summary_reason IN ('limit_steps', 'limit_time', 'stopped')),
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code ~ '^AGENT_[A-Z0-9_]+$'),
  outcome_text text CHECK (outcome_text IS NULL OR char_length(outcome_text) <= 12000),
  outcome_files jsonb,
  finished_at timestamptz,
  reported_at timestamptz,
  -- Номер вызова инструмента уникален только внутри хода, поэтому ключ повтора — пара.
  created_by_turn_id text NOT NULL,
  created_by_call_id text NOT NULL,
  -- Когда задача встала в очередь последний раз: после ответа на вопрос она встаёт снова.
  queued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by_turn_id, created_by_call_id),
  CONSTRAINT background_tasks_topic_requires_group CHECK (forum_topic_id IS NULL OR group_id IS NOT NULL),
  CONSTRAINT background_tasks_running_clock CHECK ((state IN ('running', 'stopping')) = (running_since IS NOT NULL)),
  CONSTRAINT background_tasks_waiting_shape CHECK (
    (state = 'waiting_answer') = (waiting_since IS NOT NULL AND waiting_question IS NOT NULL)
  ),
  CONSTRAINT background_tasks_outcome_shape CHECK (
    (state IN ('finished', 'failed', 'limit_time', 'limit_steps', 'stopped', 'unanswered', 'reported'))
      = (finished_at IS NOT NULL AND outcome_code IS NOT NULL)
  ),
  CONSTRAINT background_tasks_reported_shape CHECK ((state = 'reported') = (reported_at IS NOT NULL))
);

CREATE INDEX background_tasks_active_idx ON background_tasks (state, created_at)
  WHERE state IN ('queued', 'running', 'waiting_answer', 'stopping');
CREATE INDEX background_tasks_chat_idx ON background_tasks (telegram_chat_id, forum_topic_id, created_at DESC);
CREATE INDEX background_tasks_retention_idx ON background_tasks (created_at);

-- Поправки и ответы основного агента задаче. Задача видит сообщение один раз: заявка — на вызов её
-- инструмента (номер вызова уникален только внутри хода, поэтому пара), «доставлено» — когда следующий шаг
-- модели получил его в результате или новый ход задачи — во входе.
CREATE TABLE background_task_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  created_by_turn_id text NOT NULL,
  created_by_call_id text NOT NULL,
  claimed_by_turn_id text,
  claimed_by_call_id text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by_turn_id, created_by_call_id),
  CONSTRAINT background_task_messages_claim_shape CHECK ((claimed_by_turn_id IS NULL) = (claimed_by_call_id IS NULL))
);

CREATE INDEX background_task_messages_pending_idx ON background_task_messages (task_id, id)
  WHERE delivered_at IS NULL;

-- Итог и вопрос задачи для чата. В отличие от очереди пробуждений, событие повторяется, пока ход основного
-- агента по нему не закончится успешно: ни одна задача не пропадает молча.
CREATE TABLE background_task_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id bigint NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('outcome', 'question')),
  question_seq integer NOT NULL DEFAULT 0 CHECK (question_seq >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'answered', 'gave_up')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  turn_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  UNIQUE (task_id, kind, question_seq),
  CONSTRAINT background_task_events_lease_shape CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT background_task_events_answered_shape CHECK ((status = 'answered') = (answered_at IS NOT NULL))
);

CREATE INDEX background_task_events_due_idx ON background_task_events (available_at)
  WHERE status IN ('pending', 'processing');

-- Наблюдение (шаг 10). Только агрегаты: роль osinara_metrics не читает сами задачи.
-- stuck_age_seconds — сколько самая давняя идущая задача без шага (running_since сдвигается каждым шагом);
-- queue_stalled_age_seconds — сколько ждёт старейшая задача в очереди, пока место свободно (мест 3, как
-- BACKGROUND_TASK_CONCURRENCY в коде); unreported_age_seconds — сколько ждёт старейшее событие для чата, кроме
-- ожидающих, пока в чате появится разговор (человек начал новый контекст и ещё не писал).
CREATE VIEW monitoring_background_tasks AS
  SELECT tasks.running, tasks.queued, tasks.waiting_answer,
         tasks.stuck_age_seconds,
         CASE WHEN tasks.running < 3 THEN tasks.oldest_queued_age_seconds ELSE 0 END AS queue_stalled_age_seconds,
         events.unreported_age_seconds,
         events.gave_up_recent
    FROM (
      SELECT count(*) FILTER (WHERE state IN ('running', 'stopping')) AS running,
             count(*) FILTER (WHERE state = 'queued') AS queued,
             count(*) FILTER (WHERE state = 'waiting_answer') AS waiting_answer,
             COALESCE(EXTRACT(EPOCH FROM (now() - min(running_since)))::bigint, 0) AS stuck_age_seconds,
             COALESCE(EXTRACT(EPOCH FROM (now() - min(queued_at) FILTER (WHERE state = 'queued')))::bigint, 0)
               AS oldest_queued_age_seconds
        FROM background_tasks
    ) AS tasks,
    (
      SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (
               WHERE status IN ('pending', 'processing')
                 AND last_error_code IS DISTINCT FROM 'AGENT_BACKGROUND_TASK_CONVERSATION_IDLE')))::bigint, 0)
               AS unreported_age_seconds,
             count(*) FILTER (WHERE status = 'gave_up' AND created_at > now() - interval '1 day') AS gave_up_recent
        FROM background_task_events
    ) AS events;

GRANT SELECT ON monitoring_background_tasks TO osinara_metrics;
