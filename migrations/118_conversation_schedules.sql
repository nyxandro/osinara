-- Сценарий теперь может выполняться «в разговоре»: не в отдельной пустой сессии, а ходом в той же
-- сессии чата, где его поставили. Так агент сам ставит себе пробуждение по текущей задаче («проверю
-- через 10 минут») и при пробуждении видит всю переписку, свои прошлые инструменты и файлы.
--
-- Пробуждение встаёт в ту же очередь чата, что и входящие сообщения Telegram, поэтому два хода в
-- одном чате никогда не идут одновременно. Сообщения людей идут первыми: пробуждение берётся, только
-- когда в очереди чата нет ни ждущих, ни обрабатываемых сообщений, а новое сообщение ждёт, пока
-- идёт ход пробуждения. Взятое пробуждение, чей процесс упал, подхватывается заново, даже если
-- за ним уже ждут сообщения: иначе чат ждал бы пробуждение, а пробуждение — пустую очередь.
--
-- conversation_session_id — разговор, к которому привязано пробуждение. Если к моменту пробуждения
-- чат начал новый разговор, сценарий ставится на паузу с кодом AGENT_SCHEDULE_CONVERSATION_CHANGED:
-- в новом разговоре его заметка лишена контекста. Возобновление привязывает его к текущему разговору.
-- ingress_queue_id — очередь чата; она известна из сообщения, в ответ на которое сценарий создан.
ALTER TABLE agent_schedules
  ADD COLUMN execution_context text NOT NULL DEFAULT 'isolated'
    CHECK (execution_context IN ('isolated', 'conversation')),
  ADD COLUMN conversation_session_id uuid REFERENCES conversation_sessions(id) ON DELETE SET NULL,
  ADD COLUMN ingress_queue_id uuid REFERENCES telegram_ingress_queues(id) ON DELETE SET NULL,
  -- Каждое пробуждение — полный вызов модели со всей историей чата, поэтому число запусков
  -- ограничено всегда; внешние группы пробуждений не получают.
  ADD CONSTRAINT agent_schedule_conversation_shape CHECK (
    execution_context = 'isolated' OR (max_runs IS NOT NULL AND scope IN ('personal', 'family'))
  ),
  ADD CONSTRAINT agent_schedule_isolated_unbound CHECK (
    execution_context = 'conversation' OR (conversation_session_id IS NULL AND ingress_queue_id IS NULL)
  );

CREATE INDEX agent_schedules_conversation_queue
  ON agent_schedules (ingress_queue_id)
  WHERE execution_context = 'conversation';

-- Запуск в разговоре не создаёт своей сессии и не проходит восстановление обычных запусков: его
-- судьбу ведёт элемент очереди чата. Протокол 2 исключает его из обоих прежних путей восстановления.
ALTER TABLE agent_schedule_runs DROP CONSTRAINT agent_schedule_runs_recovery_protocol_check;
ALTER TABLE agent_schedule_runs
  ADD CONSTRAINT agent_schedule_runs_recovery_protocol_check CHECK (recovery_protocol IN (0, 1, 2));

-- Все пробуждения одного разговора идут в одной и той же сессии, поэтому правило «один запуск на
-- сессию» остаётся только для запусков в отдельной сессии. Запуск в разговоре однозначно определяет
-- его собственный ход.
DROP INDEX agent_schedule_runs_eve_session_idx;
CREATE UNIQUE INDEX agent_schedule_runs_eve_session_idx
  ON agent_schedule_runs (application_session_id, eve_session_id)
  WHERE application_session_id IS NOT NULL AND eve_session_id IS NOT NULL AND recovery_protocol <> 2;
CREATE UNIQUE INDEX agent_schedule_runs_conversation_turn_idx
  ON agent_schedule_runs (eve_session_id, eve_turn_id)
  WHERE recovery_protocol = 2 AND eve_turn_id IS NOT NULL;

-- Пробуждение в очереди чата. Пока оно ждёт или идёт, сценарий остаётся занятым (leased) без срока
-- аренды: сколько ждать, решает очередь, а не таймер сценария.
-- available_at откладывает пробуждение, пока разговор ждёт ответа человека на подтверждение.
-- dispatch_id метит события хода пробуждения в потоке сессии, как у обычного сообщения;
-- admission_deadline_at — срок, после которого Eve уже не начнёт этот ход.
CREATE TABLE telegram_ingress_wakeups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES telegram_ingress_queues(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
  run_id uuid NOT NULL UNIQUE REFERENCES agent_schedule_runs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  dispatch_started_at timestamptz,
  dispatch_id uuid,
  admission_deadline_at timestamptz,
  eve_session_id text,
  dispatch_start_index bigint CHECK (dispatch_start_index >= 0),
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((dispatch_started_at IS NULL) = (eve_session_id IS NULL)),
  CHECK ((dispatch_started_at IS NULL) = (dispatch_start_index IS NULL)),
  CHECK ((dispatch_started_at IS NULL) = (dispatch_id IS NULL)),
  CHECK ((dispatch_started_at IS NULL) = (admission_deadline_at IS NULL)),
  CHECK ((last_error_code IS NULL) = (last_error_message IS NULL)),
  CHECK (completed_at IS NULL OR status IN ('completed', 'failed'))
);

CREATE INDEX telegram_ingress_wakeups_open
  ON telegram_ingress_wakeups (queue_id, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX telegram_ingress_wakeups_schedule
  ON telegram_ingress_wakeups (schedule_id);

-- Пробуждение, взятое в работу, отмечается на строке очереди чата. Взятие сообщения проверяет эту
-- отметку на той же строке, которую блокирует, поэтому сообщение и пробуждение, взятые двумя
-- процессами в одно мгновение, не могут пойти одновременно: второй увидит отметку первого.
-- Отметку снимает каждый конечный переход пробуждения; удаление пробуждения снимает её само.
ALTER TABLE telegram_ingress_queues
  ADD COLUMN active_wakeup_id uuid REFERENCES telegram_ingress_wakeups(id) ON DELETE SET NULL;

-- Ход пробуждения занимает очередь чата так же, как ход сообщения. Без этого сообщение, ждущее
-- конца пробуждения, считалось бы остановкой, а длинное пробуждение не попадало бы в самый долгий ход.
CREATE OR REPLACE VIEW monitoring_telegram_ingress AS
  SELECT
    count(*) FILTER (WHERE status = 'pending')    AS pending,
    count(*) FILTER (WHERE status = 'processing') AS processing,
    count(*) FILTER (WHERE status = 'failed')     AS failed,
    coalesce(
      extract(epoch FROM now() - min(received_at) FILTER (WHERE status = 'pending')),
      0
    ) AS oldest_pending_age_seconds,
    (
      SELECT coalesce(extract(epoch FROM now() - min(waiting.received_at))::bigint, 0)
      FROM telegram_ingress_updates waiting
      WHERE (waiting.status = 'pending'
             OR (waiting.status = 'processing'
                 AND (waiting.lease_expires_at <= now() OR waiting.dispatch_started_at IS NULL)))
        AND NOT EXISTS (
          SELECT 1 FROM telegram_ingress_updates running
          WHERE running.queue_id = waiting.queue_id AND running.status = 'processing'
            AND running.lease_expires_at > now() AND running.dispatch_started_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM telegram_ingress_wakeups running
          WHERE running.queue_id = waiting.queue_id AND running.status = 'processing'
            AND running.lease_expires_at > now() AND running.dispatch_started_at IS NOT NULL
        )
    ) AS stalled_oldest_age_seconds,
    (
      SELECT coalesce(extract(epoch FROM now() - min(started))::bigint, 0)
      FROM (
        SELECT dispatch_started_at AS started FROM telegram_ingress_updates
         WHERE status = 'processing' AND lease_expires_at > now() AND dispatch_started_at IS NOT NULL
        UNION ALL
        SELECT dispatch_started_at FROM telegram_ingress_wakeups
         WHERE status = 'processing' AND lease_expires_at > now() AND dispatch_started_at IS NOT NULL
      ) running
    ) AS longest_running_seconds
  FROM telegram_ingress_updates;

GRANT SELECT ON monitoring_telegram_ingress TO osinara_metrics;
