-- Сохранённые значения в прежнем формате получают текущие имена:
-- - источник записи памяти, сделанной во время хода, — `turn:<сессия>:<ход>` вместо `eve:…`;
-- - ключи верхнего уровня с идентификатором сессии или хода в метаданных аудита и контексте
--   инцидентов: `eveSessionId` → `agentSessionId`, `previousEveTurnId` → `previousAgentTurnId` и так
--   же для остальных.
-- Другие ключи не трогаются: `fromEveVersion` в записях давнего переезда хранит версию прежнего
-- фреймворка, и новое имя исказило бы историю. Вложенные объекты тоже не трогаются: в схеме
-- приложения таких ключей нет, а чужие данные внутри метаданных переписывать нельзя.

UPDATE memory_items_all SET source = 'turn:' || substr(source, length('eve:') + 1)
 WHERE source LIKE 'eve:%';

UPDATE audit_events SET metadata = (
  SELECT jsonb_object_agg(regexp_replace(regexp_replace(key, '^eve(?=(Session|Turn)Id$)', 'agent'), '([a-z])Eve(?=(Session|Turn)Id$)', '\1Agent'), value)
    FROM jsonb_each(metadata)
) WHERE jsonb_typeof(metadata) = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(metadata) AS key WHERE key ~ '^eve(Session|Turn)Id$|[a-z]Eve(Session|Turn)Id$');

UPDATE operational_incidents SET context = (
  SELECT jsonb_object_agg(regexp_replace(regexp_replace(key, '^eve(?=(Session|Turn)Id$)', 'agent'), '([a-z])Eve(?=(Session|Turn)Id$)', '\1Agent'), value)
    FROM jsonb_each(context)
) WHERE jsonb_typeof(context) = 'object'
    AND EXISTS (SELECT 1 FROM jsonb_object_keys(context) AS key WHERE key ~ '^eve(Session|Turn)Id$|[a-z]Eve(Session|Turn)Id$');
