-- Лейны, застрявшие до появления статуса skipped: голова в failed или ambiguous занимает место на
-- курсоре, а за ней уже стоит цепочка завершённых пакетов, недостижимых от курсора (Ft86 стоял так
-- с 3 сентября 2026: голова ambiguous@546, завершённые @547 и @561, курсор на 546, 1400 сообщений
-- без проверки). Голова с наследником становится skipped (её источники теряются для проверки, как
-- и при живом решении resolveAbandonedReviewBatch), курсор проходит по цепочке completed/skipped.
-- Голова без наследника не трогается: её отпускает обычный проход, а при провенансе она честно
-- остаётся терминальной.
DO $$
DECLARE
  lane RECORD;
  cursor_sequence bigint;
  next_through bigint;
  head RECORD;
BEGIN
  FOR lane IN SELECT id, processed_through_sequence FROM memory_review_lanes LOOP
    cursor_sequence := lane.processed_through_sequence;
    LOOP
      SELECT batch.id, batch.status, batch.through_sequence INTO head
        FROM memory_review_batches AS batch
       WHERE batch.lane_id = lane.id AND batch.predecessor_sequence = cursor_sequence
       LIMIT 1;
      EXIT WHEN NOT FOUND;
      IF head.status IN ('failed', 'ambiguous') THEN
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM memory_review_batches AS successor
           WHERE successor.lane_id = lane.id
             AND successor.predecessor_sequence = head.through_sequence
             AND successor.status IN ('completed', 'skipped'));
        UPDATE memory_review_batches
           SET status = 'skipped', updated_at = now(), lease_token = NULL, lease_expires_at = NULL
         WHERE id = head.id;
        DELETE FROM memory_review_batch_sources WHERE batch_id = head.id;
        RAISE NOTICE 'memory review lane % head % skipped at cursor %', lane.id, head.id, cursor_sequence;
      ELSIF head.status NOT IN ('completed', 'skipped') THEN
        EXIT;
      END IF;
      cursor_sequence := head.through_sequence;
    END LOOP;
    IF cursor_sequence <> lane.processed_through_sequence THEN
      UPDATE memory_review_lanes
         SET processed_through_sequence = cursor_sequence, updated_at = now()
       WHERE id = lane.id;
      RAISE NOTICE 'memory review lane % cursor % -> %', lane.id, lane.processed_through_sequence, cursor_sequence;
    END IF;
  END LOOP;
END $$;
