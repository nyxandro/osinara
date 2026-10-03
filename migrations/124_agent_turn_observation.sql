-- Отметки о том, что приложение узнало об исходе хода. Ход сначала записывает своё состояние, потом
-- сообщает о нём приложению: показывает карточку подтверждения, закрывает запуск по расписанию,
-- освобождает источники памяти. Если процесс упал между этими двумя шагами, следующий процесс
-- по пустой отметке сообщает о ходе ещё раз, и чат не остаётся без кнопки, а запуск — незакрытым.
--
-- input_presented_at — запрос человеку (подтверждение или вопрос) показан в канале.
-- finish_observed_at — приложение услышало, чем закончился запуск хода: ответом, ожиданием
-- человека, ошибкой или отменой. Ставится и тогда, когда обработчик упал: ошибка уже сообщена
-- вызвавшему, повтор по кругу её не исправит.
-- Колонки только добавляются: прежняя версия приложения их не читает.
ALTER TABLE agent_turns
  ADD COLUMN input_presented_at timestamptz,
  ADD COLUMN finish_observed_at timestamptz;

-- Ходы, закончившиеся до этой миграции, о себе уже сообщили.
UPDATE agent_turns SET finish_observed_at = updated_at WHERE status <> 'running';
UPDATE agent_turns SET input_presented_at = updated_at WHERE status = 'waiting_input';

CREATE INDEX agent_turns_unobserved ON agent_turns (status) WHERE finish_observed_at IS NULL;
