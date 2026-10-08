-- Журнал показов знает, откуда модель увидела запись (#339). Раньше в нём были только записи
-- автоподборки хода, и использование засчитывалось только для них: запись, найденную явным
-- поиском, показанную профилем или листанием, модель называла использованной, а счётчик её
-- отклонял, и кривая забывания старила её как невостребованную.
--
-- source: selection — автоподборка хода (и профиль из её же находок), profile — постоянные
-- утверждения профиля, search — явный search_memories, list — листание list_memories.
-- Отбор повторов автоподборки смотрит только на selection: результат поиска лежит в истории как
-- вывод инструмента, а не как блок памяти хода.
ALTER TABLE memory_retrieval_shows
  ADD COLUMN source text NOT NULL DEFAULT 'selection'
    CHECK (source IN ('selection', 'profile', 'search', 'list'));

-- Какой ход засчитал этот показ. Использование засчитывается по показам всей сессии беседы, и
-- без этой отметки повторная обработка того же хода засчитала бы следующий непотраченный показ.
-- Прежде показ засчитывал только его собственный ход.
ALTER TABLE memory_retrieval_shows ADD COLUMN used_turn_id text;
UPDATE memory_retrieval_shows SET used_turn_id = turn_id WHERE used_at IS NOT NULL;
ALTER TABLE memory_retrieval_shows
  ADD CONSTRAINT memory_retrieval_shows_used_turn
    CHECK ((used_at IS NULL) = (used_turn_id IS NULL));
