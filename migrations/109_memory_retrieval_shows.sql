-- Автоподборка памяти собирается заново на каждый ход и ничего не знает о предыдущих ходах.
-- Порядок объединения рангов по построению устойчив, поэтому на похожие вопросы внутри одного
-- разговора наверх выходят те же записи. Замер боевых логов: 348 показов на 178 уникальных
-- записей, самая липкая заняла слот в 14 ходах из 29, 14% записей повторяются с прошлым ходом.
-- Каждый такой показ вытесняет запись, которую модель ещё не видела.
--
-- Журнал показов даёт подборке память о самой себе. Окно считается в ходах, а не во времени:
-- тогда тихий чат ведёт себя так же, как активный, и поведение не зависит от того, как долго
-- человек молчал.
--
-- Журнал ведётся только для автоподборки. Явный поиск по-прежнему видит всё: если модель
-- целенаправленно ищет факт, скрывать его от неё нельзя.
CREATE TABLE memory_retrieval_shows (
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  turn_id text NOT NULL CHECK (char_length(turn_id) > 0),
  -- Номер хода внутри беседы: возрастает на единицу за ход, независимо от пауз между ними.
  turn_ordinal bigint NOT NULL CHECK (turn_ordinal > 0),
  claim_id uuid NOT NULL REFERENCES memory_items_all(id) ON DELETE CASCADE,
  shown_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, turn_id, claim_id)
);

-- Подборка спрашивает «что показывали в последних N ходах этой беседы» — это и есть порядок.
CREATE INDEX memory_retrieval_shows_window
  ON memory_retrieval_shows (conversation_id, turn_ordinal DESC, claim_id);

-- Номер хода выдаётся один раз на ход: повторная обработка того же хода не должна сдвигать окно.
CREATE TABLE memory_retrieval_turns (
  conversation_id uuid NOT NULL REFERENCES application_conversations(id) ON DELETE CASCADE,
  turn_id text NOT NULL CHECK (char_length(turn_id) > 0),
  turn_ordinal bigint NOT NULL CHECK (turn_ordinal > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, turn_id),
  UNIQUE (conversation_id, turn_ordinal)
);
