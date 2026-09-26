-- «Пью кофе без сахара» не отменяет «пьёт кофе с двумя ложками»: у записи нет поля, говорящего,
-- о каком свойстве субъекта она. Обе версии живут активными на равных правах, обе попадают в
-- выдачу, и какая окажется выше — зависит от совпадения слов с вопросом, а не от того, какая
-- новее. Человек это видит как «ассистент не запомнил», хотя он запомнил, и старое тоже.
--
-- Слот — короткое имя свойства («кофе», «место работы», «размер обуви»), а не его значение.
-- Новая запись того же субъекта с тем же слотом переводит прежнюю в `superseded`; прежняя не
-- удаляется, остаётся в списке и экспорте и ссылается на сменщицу через `superseded_by`.
--
-- Эпизод слота не получает: он о конкретном моменте, а не о свойстве, которое меняется.
-- У существующих записей слот пустой, и замещение их не трогает.
ALTER TABLE memory_items_all
  ADD COLUMN attribute text,
  ADD CONSTRAINT memory_items_attribute_shape CHECK (
    attribute IS NULL OR (
      char_length(attribute) BETWEEN 1 AND 40
      AND attribute = btrim(attribute)
      AND attribute = lower(attribute)
      AND kind <> 'episode'
    )
  );

-- Замещение ищет «активные записи этого субъекта с этим слотом» внутри одной области памяти.
-- Область в ключе обязательна: личная запись не должна замещать семейную.
CREATE INDEX memory_items_all_attribute_slot
  ON memory_items_all (family_id, scope, scope_partition_key, attribute)
  WHERE attribute IS NOT NULL AND claim_status = 'active' AND deleted_at IS NULL;

-- `memory_items` — представление с `SELECT *`, развёрнутым в список колонок в момент создания.
CREATE OR REPLACE VIEW memory_items AS
  SELECT * FROM memory_items_all WHERE deleted_at IS NULL;
