-- Фоновая проверка группы сохраняла записи с именем свойства "null" — вероятно, копируя
-- `"attribute": null`, который видела у записей без свойства в блоке уже сохранённых записей.
-- Сервер принимал "null" за имя свойства, и каждая следующая такая запись о том же человеке
-- уводила предыдущую в историю, хотя речь шла о разных вещах. На проде 23.09 и 02.10.2026 так
-- сохранено 10 записей, три из них погашены несвязанными фактами (фанат TDD — записью о том, как
-- человек нанимает людей). С этого выпуска такие имена получают отказ, а блок записей не
-- показывает пустое поле; здесь чинятся уже сохранённые записи.
--
-- Погашенная через такой слот запись снова становится текущей и больше не ссылается на ту, что её
-- погасила; связь temporal_update с этим слотом удаляется. Так же уже устроена отмена записи
-- (`releaseMemoryAttributeSlot`): гашение по слоту обратимо. Исправление (связь correction) не
-- трогается — оно гасит исправленную формулировку, и возвращать её нельзя. Затем имя свойства
-- снимается со всех таких записей, текущих и погашенных, без смены updated_at: текст записи не
-- менялся, а модель читает updatedAt как правку текста, и список памяти сортируется по нему. Имена
-- хранятся в нижнем регистре (ограничение memory_items_attribute_shape), поэтому сравнение точное.
UPDATE memory_items_all AS previous
   SET claim_status = 'active', superseded_by = NULL, updated_at = now()
  FROM claim_relations AS relation
 WHERE relation.source_claim_id = previous.id
   AND relation.relation_type = 'temporal_update'
   AND relation.detection_metadata->>'attribute' IN ('null', 'none', 'undefined')
   AND previous.claim_status = 'superseded'
   AND previous.superseded_by = relation.target_claim_id;

DELETE FROM claim_relations
 WHERE relation_type = 'temporal_update'
   AND detection_metadata->>'attribute' IN ('null', 'none', 'undefined');

UPDATE memory_items_all
   SET attribute = NULL
 WHERE attribute IN ('null', 'none', 'undefined');
