-- Сведение, не прошедшее индексацию, остаётся активным и видно в списке памяти, но смысловой поиск
-- его не находит никогда: ветка отбирает только `embedding_status = 'indexed'`. Снаружи это
-- неотличимо от обычного промаха поиска, поэтому разбираться никто не идёт.
--
-- Наблюдение за очередью задач (`monitoring_memory_embedding_jobs`) этот случай не ловит. Оно
-- считает задачи, изменившиеся за последние сутки, а задача, упавшая неделю назад, из окна вышла —
-- при этом запись как была невидимой, так и осталась. Нужно стоячее состояние самих записей, а не
-- недавняя активность очереди: оно не гаснет само и держится, пока запись действительно не
-- проиндексирована.
CREATE VIEW monitoring_memory_index_state AS
  SELECT embedding_status::text AS embedding_status, count(*) AS total
  FROM memory_items
  WHERE claim_status = 'active'
  GROUP BY embedding_status;

GRANT SELECT ON monitoring_memory_index_state TO osinara_metrics;
