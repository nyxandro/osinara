-- Голос, виджеты и кнопка сброса в сценариях (#480, docs/plans/[09.11.2026]-scenario-voice-and-widgets.md).
--
-- Кнопка «прочитано» под сообщением сценария сбрасывает связанный сценарий на сегодня без модели: его
-- оставшиеся запуски до полуночи по часовому поясу сценария проходят, не запускаясь. `skipped_until` —
-- до какого момента пропускать, `skipped_at` — когда человек нажал; оба пусты, пока сброса не было.
ALTER TABLE agent_schedules
  ADD COLUMN skipped_until timestamptz,
  ADD COLUMN skipped_at timestamptz,
  ADD CONSTRAINT agent_schedules_skip_shape CHECK ((skipped_until IS NULL) = (skipped_at IS NULL));

-- Кнопки под карточкой-виджетом: набор живёт как у ответа хода, но с собственным происхождением
-- `widget` без привязки к ходу, чтобы итоговый ответ того же хода не принял его за свой. Подпись
-- карточки — текст набора; после выбора кнопки меняются правкой клавиатуры (формат `widget`).
ALTER TABLE telegram_reply_button_sets
  DROP CONSTRAINT telegram_reply_button_sets_origin_check,
  DROP CONSTRAINT telegram_reply_button_sets_origin_shape,
  DROP CONSTRAINT telegram_reply_button_sets_message_format_check;

ALTER TABLE telegram_reply_button_sets
  ADD CONSTRAINT telegram_reply_button_sets_origin_check CHECK (origin IN ('turn', 'reminder', 'widget')),
  ADD CONSTRAINT telegram_reply_button_sets_origin_shape CHECK (
    (origin = 'turn' AND agent_session_id IS NOT NULL AND agent_turn_id IS NOT NULL)
    OR (origin IN ('reminder', 'widget') AND agent_session_id IS NULL AND agent_turn_id IS NULL)
  ),
  ADD CONSTRAINT telegram_reply_button_sets_message_format_check CHECK (message_format IN ('plain', 'rich', 'widget'));
