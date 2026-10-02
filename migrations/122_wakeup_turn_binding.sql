-- Пробуждение создаёт ход ядра в одной транзакции с отметкой о передаче. Номер хода хранится рядом:
-- после перезапуска пробуждение доделывает свой ход, а не ищет его по потоку событий Eve.
-- Колонка только добавляется: прежняя версия её не читает, откат на неё не требует миграции.
ALTER TABLE telegram_ingress_wakeups
  ADD COLUMN turn_id text,
  ADD CONSTRAINT telegram_ingress_wakeups_turn_dispatched CHECK (turn_id IS NULL OR dispatch_started_at IS NOT NULL);
