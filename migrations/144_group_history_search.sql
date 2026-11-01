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
