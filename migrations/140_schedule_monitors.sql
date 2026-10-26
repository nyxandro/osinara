-- Монитор: пробуждение «в разговоре», которое зовёт модель только по событию. На каждом тике
-- планировщик сам, без модели, выполняет в песочнице чата короткий скрипт агента. Пустой вывод —
-- ничего не случилось: тик не становится запуском и не тратит лимит пробуждений. Напечатанный текст —
-- событие: агент просыпается в разговоре с этим текстом. Ненулевой код выхода — сломанная проверка.
--
-- check_until — конец слежения. Следующий тик никогда не назначается позже него, и тик, назначенный
-- ровно на него, последний: после него монитор завершается, а агент сообщает итог.
-- check_failures — сломанные проверки подряд; после нескольких агент просыпается чинить скрипт.
-- check_unavailable — тики подряд, когда проверку не удалось даже запустить (песочница недоступна).
-- Это не вина скрипта, и агента это не будит; после нескольких подряд владелец получает инцидент.
-- Пять минут — нижняя граница частоты: проверка держит контейнер песочницы чата включённым.
ALTER TABLE agent_schedules
  ADD COLUMN check_command text CHECK (char_length(check_command) BETWEEN 1 AND 4000),
  ADD COLUMN check_until timestamptz,
  ADD COLUMN check_failures integer NOT NULL DEFAULT 0 CHECK (check_failures >= 0),
  ADD COLUMN check_unavailable integer NOT NULL DEFAULT 0 CHECK (check_unavailable >= 0),
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN last_check_error_code text,
  ADD CONSTRAINT agent_schedule_check_shape CHECK (
    (check_command IS NULL AND check_until IS NULL AND check_failures = 0 AND check_unavailable = 0
      AND last_checked_at IS NULL AND last_check_error_code IS NULL)
    OR (check_command IS NOT NULL AND check_until IS NOT NULL AND execution_context = 'conversation'
      AND recurrence_kind <> 'once'
      AND NOT (recurrence_kind = 'minutely' AND recurrence_interval < 5))
  );

-- Чем вызван запуск монитора: событием (fired), сломанной проверкой (failed) или концом слежения
-- (expired). check_output — что увидит модель: вывод скрипта или конец его ошибки.
ALTER TABLE agent_schedule_runs
  ADD COLUMN check_trigger text CHECK (check_trigger IN ('fired', 'failed', 'expired')),
  ADD COLUMN check_output text CHECK (char_length(check_output) <= 4000),
  ADD CONSTRAINT agent_schedule_runs_check_output_shape CHECK (check_trigger IS NOT NULL OR check_output IS NULL);
