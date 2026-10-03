-- Сохранённые значения в прежнем формате получают текущие имена:
-- - источник записи памяти, сделанной во время хода, — `turn:<сессия>:<ход>` вместо `eve:…`;
-- - ключи верхнего уровня в метаданных аудита и контексте инцидентов: `eveSessionId` →
--   `agentSessionId`, `previousEveTurnId` → `previousAgentTurnId` и так же для остальных.
-- Ключ с прежним словом только в середине значения или во вложенном объекте не трогается: в схеме
-- приложения таких нет, а чужие данные внутри метаданных переписывать нельзя.

UPDATE memory_items_all SET source = 'turn:' || substr(source, length('eve:') + 1)
 WHERE source LIKE 'eve:%';

UPDATE audit_events SET metadata = (
  SELECT jsonb_object_agg(regexp_replace(regexp_replace(key, '^eve(?=[A-Z])', 'agent'), '([a-z])Eve(?=[A-Z])', '\1Agent', 'g'), value)
    FROM jsonb_each(metadata)
) WHERE jsonb_typeof(metadata) = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(metadata) AS key WHERE key ~ '^eve[A-Z]|[a-z]Eve[A-Z]');

UPDATE operational_incidents SET context = (
  SELECT jsonb_object_agg(regexp_replace(regexp_replace(key, '^eve(?=[A-Z])', 'agent'), '([a-z])Eve(?=[A-Z])', '\1Agent', 'g'), value)
    FROM jsonb_each(context)
) WHERE jsonb_typeof(context) = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(context) AS key WHERE key ~ '^eve[A-Z]|[a-z]Eve[A-Z]');
