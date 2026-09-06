-- Тихая проверка памяти запускается по простою, поэтому фоновый батч больше не обязан
-- содержать ровно 50 сообщений. Верхняя граница остаётся в CHECK source_count BETWEEN 1 AND 50.
DO $$
DECLARE
  fixed_size_constraint text;
BEGIN
  SELECT conname INTO fixed_size_constraint
    FROM pg_constraint
   WHERE conrelid = 'memory_review_batches'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%source_count = 50%';
  IF fixed_size_constraint IS NULL THEN
    RAISE EXCEPTION
      'AGENT_MIGRATION_084_CONSTRAINT_MISSING: memory_review_batches fixed-size check not found';
  END IF;
  EXECUTE format('ALTER TABLE memory_review_batches DROP CONSTRAINT %I', fixed_size_constraint);
END;
$$;

-- Резерв под слоты профиля (attribute) и время события (occurred_at). Пока пишутся только NULL.
ALTER TABLE memory_items_all
  ADD COLUMN attribute text CHECK (attribute IS NULL OR char_length(attribute) BETWEEN 1 AND 64),
  ADD COLUMN occurred_at timestamptz;

-- `SELECT *` разворачивается при создании представления; новые колонки нужно добавить явно.
-- CREATE OR REPLACE VIEW допускает только добавление колонок в конец, что здесь и происходит.
CREATE OR REPLACE VIEW memory_items AS
  SELECT * FROM memory_items_all WHERE deleted_at IS NULL;
