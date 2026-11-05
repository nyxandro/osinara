-- Отключение группы с сохранением данных (#465, docs/plans/group-disconnect.md).
--
-- Отключённая группа хранит историю, память, файлы и настройки, но не записывает новых сообщений, не отвечает и не
-- исполняет напоминаний и сценариев. Отключает владелец или само приложение, когда бота удалили из чата.
-- `bot_membership_changed_at` — время последнего события Telegram о членстве бота: более старое событие,
-- доставленное позже, состояние не меняет. `last_pause_*` — последний перерыв: когда начался, когда кончился и
-- после какого сообщения истории; по ним агент знает, что сообщений того времени у него нет. Существующие группы
-- остаются подключёнными.
ALTER TABLE telegram_groups
  ADD COLUMN disconnected_at timestamptz,
  ADD COLUMN disconnected_reason text,
  ADD COLUMN disconnected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN bot_membership_changed_at timestamptz,
  ADD COLUMN last_pause_started_at timestamptz,
  ADD COLUMN last_pause_ended_at timestamptz,
  ADD COLUMN last_pause_after_sequence bigint;

ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_disconnection_shape CHECK (
    (disconnected_at IS NULL AND disconnected_reason IS NULL AND disconnected_by IS NULL) OR
    (disconnected_at IS NOT NULL AND disconnected_reason IN ('owner', 'bot_removed'))
  );

ALTER TABLE telegram_groups
  ADD CONSTRAINT telegram_groups_last_pause_shape CHECK (
    (last_pause_started_at IS NULL AND last_pause_ended_at IS NULL AND last_pause_after_sequence IS NULL) OR
    (last_pause_started_at IS NOT NULL AND last_pause_ended_at >= last_pause_started_at AND
     last_pause_after_sequence >= 0)
  );
