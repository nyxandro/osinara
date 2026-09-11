-- Only new private-chat albums are collected. Existing dispatches and their provenance stay intact.
ALTER TABLE telegram_ingress_updates
  ADD COLUMN media_group_key text CHECK (char_length(media_group_key) > 0),
  ADD COLUMN media_group_ready_at timestamptz,
  ADD COLUMN media_group_closed_at timestamptz,
  ADD COLUMN media_group_leader_id bigint REFERENCES telegram_ingress_updates(update_id) ON DELETE CASCADE,
  ADD COLUMN media_group_late boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT telegram_ingress_media_group_shape CHECK (
    (media_group_key IS NULL) = (media_group_ready_at IS NULL)
    AND (media_group_closed_at IS NULL OR media_group_key IS NOT NULL)
    AND (media_group_leader_id IS NULL OR (media_group_key IS NULL AND media_group_leader_id <> update_id))
    AND (NOT media_group_late OR media_group_leader_id IS NOT NULL)
  );

CREATE UNIQUE INDEX telegram_ingress_media_group_key
  ON telegram_ingress_updates(queue_id, media_group_key) WHERE media_group_key IS NOT NULL;
CREATE INDEX telegram_ingress_media_group_members
  ON telegram_ingress_updates(media_group_leader_id) WHERE media_group_leader_id IS NOT NULL;
