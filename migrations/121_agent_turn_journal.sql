-- Журнал ходов собственного ядра агента: по нему ход продолжается после падения процесса и после
-- нажатия кнопки подтверждения, не повторяя уже сделанного. Раньше это состояние жило в базе Eve.
--
-- agent_turns — один ход; sequence — его порядковый номер в сессии. Новый ход получает глобально
-- уникальный id `turn_<ULID>`: таблицы барьеров «ровно один раз» (доставка ответа, уведомления,
-- источники памяти) уникальны по паре «сессия + ход», а номера Eve `turn_0`, `turn_1` повторялись
-- бы внутри перенесённой сессии.
-- - status: running — ход идёт; waiting_input — ход закончил свою работу и ждёт ответа человека на
--   подтверждение или вопрос; completed / failed / cancelled — ход закончен.
-- - auth — кто действует сейчас и кто начал ход; channel — куда и как отвечать; input — сообщение
--   и строки контекста, с которыми ход начался.
-- - prepared — инструкции хода и набор скиллов, собранные один раз в начале. После перезапуска ход
--   продолжается с тем же системным промптом, а не пересобирает его (память могла измениться).
-- - pending_context — строки контекста, пришедшие с частичным ответом на пачку подтверждений; их
--   получит ход-продолжение вместе со строками последнего ответа.
-- - resumes_turn_id — ход-продолжение: он исполняет подтверждённые вызовы ждавшего хода, кладёт их
--   стенограмму в историю и дальше работает как обычный ход. Так было и в Eve: нажатие кнопки
--   начинало новый ход со своими инструкциями и набором инструментов.
-- - history_started — вход хода уже лежит в истории: шаг или ожидание ответа человека записаны.
-- - runner_id — процесс, который ведёт ход. Ход без живого владельца продолжает следующий процесс.
-- В сессии ждёт ответа человека не больше одного хода: пока висит подтверждение, следующие ходы идут
-- без инструментов, а новое сообщение снимает висящий вопрос.
--
-- agent_turn_steps — ответ модели на шаге хода. Записанный ответ модели не запрашивается повторно.
-- text_emitted_at — текст шага отдан каналу; продолжение после подтверждения его не повторяет.
--
-- agent_tool_calls — вызов инструмента из ответа модели. state:
-- - awaiting_input — ждёт решения человека (подтверждение или ответ на вопрос);
-- - planned — решено выполнить, выполнение ещё не начиналось;
-- - intent — записано прямо перед выполнением: действие могло начаться;
-- - completed — результат для модели записан;
-- - unknown — процесс упал посреди действия с последствиями: исход неизвестен, повтора нет.
-- input_response — ответ человека на этот вызов; решение по одному подтверждению из пачки
-- сохраняется, пока ждут остальные.
-- output — результат в формате AI SDK, который увидит модель.
CREATE TABLE agent_turns (
  id text PRIMARY KEY CHECK (id ~ '^turn_[0-9A-HJKMNP-TV-Z]{26}$'),
  session_id text NOT NULL REFERENCES agent_session_state(session_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  kind text NOT NULL CHECK (kind IN ('conversation', 'scheduled', 'wakeup', 'memory_review', 'subagent')),
  status text NOT NULL CHECK (status IN ('running', 'waiting_input', 'completed', 'failed', 'cancelled')),
  parent_turn_id text REFERENCES agent_turns(id) ON DELETE CASCADE,
  parent_call_id text CHECK (parent_call_id IS NULL OR char_length(parent_call_id) > 0),
  auth json NOT NULL,
  channel json NOT NULL,
  input json NOT NULL,
  prepared json,
  pending_context json,
  resumes_turn_id text REFERENCES agent_turns(id) ON DELETE CASCADE,
  history_started boolean NOT NULL DEFAULT false,
  next_step_index integer NOT NULL DEFAULT 0 CHECK (next_step_index >= 0),
  runner_id text CHECK (runner_id IS NULL OR char_length(runner_id) > 0),
  final_text text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((parent_turn_id IS NULL) = (parent_call_id IS NULL)),
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);

CREATE UNIQUE INDEX agent_turns_session_sequence ON agent_turns (session_id, sequence);
CREATE UNIQUE INDEX agent_turns_session_waiting ON agent_turns (session_id) WHERE status = 'waiting_input';
CREATE INDEX agent_turns_unfinished ON agent_turns (status, updated_at) WHERE status IN ('running', 'waiting_input');
CREATE UNIQUE INDEX agent_turns_continuation ON agent_turns (resumes_turn_id) WHERE resumes_turn_id IS NOT NULL;
CREATE UNIQUE INDEX agent_turns_child_call ON agent_turns (parent_turn_id, parent_call_id) WHERE parent_turn_id IS NOT NULL;

CREATE TABLE agent_turn_steps (
  turn_id text NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  step_index integer NOT NULL CHECK (step_index >= 0),
  response json NOT NULL,
  finish_reason text NOT NULL CHECK (char_length(finish_reason) > 0),
  usage json,
  text_emitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, step_index)
);

CREATE TABLE agent_tool_calls (
  turn_id text NOT NULL,
  step_index integer NOT NULL,
  call_id text NOT NULL CHECK (char_length(call_id) > 0),
  position integer NOT NULL CHECK (position >= 0),
  tool_name text NOT NULL CHECK (char_length(tool_name) > 0),
  input json NOT NULL,
  state text NOT NULL CHECK (state IN ('awaiting_input', 'planned', 'intent', 'completed', 'unknown')),
  input_request json,
  input_response json,
  output json,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, call_id),
  UNIQUE (turn_id, step_index, position),
  FOREIGN KEY (turn_id, step_index) REFERENCES agent_turn_steps(turn_id, step_index) ON DELETE CASCADE,
  CHECK ((state IN ('completed', 'unknown')) = (output IS NOT NULL)),
  CHECK (state <> 'awaiting_input' OR input_request IS NOT NULL),
  CHECK (input_response IS NULL OR input_request IS NOT NULL)
);
