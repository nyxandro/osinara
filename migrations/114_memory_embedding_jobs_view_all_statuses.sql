-- Представление писалось как отчёт о содержимом очереди, а читается как счётчик состояния. Для
-- отчёта ноль строк — честный ответ; для наблюдения нужен противоположный контракт: величина
-- должна существовать всегда. Пока в таблице годами лежала одна отказавшая задача, метрика
-- выглядела рабочей и держалась на этой строке. Переиндексация 20 сентября её убрала, и второй
-- шаг runbook тревоги об индексации перестал работать вовсе: дежурный получал пустой ответ,
-- неотличимый от «отказов нет», «метрика не собирается» и «я неправильно написал запрос».
--
-- Список статусов повторяет CHECK таблицы из 006_hybrid_memory.sql, и сам по себе о расхождении
-- не сообщит: новый статус просто исчезнет из метрики той же тишиной, ради которой всё и делается.
-- Поэтому расхождение ловит интеграционная проверка, которая сверяет выдачу представления с CHECK.
CREATE OR REPLACE VIEW monitoring_memory_embedding_jobs AS
  SELECT
    known.status AS status,
    count(job.memory_item_id) AS total,
    count(job.memory_item_id) FILTER (WHERE job.updated_at > now() - interval '24 hours') AS recent
  FROM unnest(ARRAY['pending', 'leased', 'failed']) AS known(status)
  LEFT JOIN memory_embedding_jobs AS job ON job.status = known.status
  GROUP BY known.status;

GRANT SELECT ON monitoring_memory_embedding_jobs TO osinara_metrics;
