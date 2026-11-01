-- Поиск по истории чата (list_group_history): сообщение подходит, когда в нём есть каждое слово
-- запроса в любом порядке — как кусок текста, в другой форме слова, другой раскладкой или с
-- небольшой опечаткой. История хранит до 500 000 сообщений на чат, и без индексов каждый поиск
-- перебирал бы их все. Триграммы закрывают кусок текста (ILIKE) и опечатку (<%), русский
-- поисковый вектор — формы слов. Выражение вектора совпадает с запросом в
-- agent/lib/group-history-search/history-query-terms.ts буква в букву, иначе индекс не применится.
CREATE INDEX telegram_group_messages_content_trigram
  ON telegram_group_messages USING gin (content_text gin_trgm_ops);

CREATE INDEX telegram_group_messages_content_russian
  ON telegram_group_messages USING gin (to_tsvector('russian', coalesce(content_text, '')));

-- Удаление сообщения обнуляет ссылки ответов на него (ON DELETE SET NULL), и без этого индекса
-- каждое удаление перебирало бы всю таблицу: при 500 000 сообщений на чат это каждое новое
-- сообщение заполненного чата и часы на удаление группы.
CREATE INDEX telegram_group_messages_reply_to_entry
  ON telegram_group_messages (reply_to_entry_id) WHERE reply_to_entry_id IS NOT NULL;

-- История группы за период (сценарии по расписанию) читается по времени отправки.
CREATE INDEX telegram_group_messages_group_sent_at
  ON telegram_group_messages (group_id, sent_at);
