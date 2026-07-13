-- The old runtime did not record receipt-time trust zones. Tombstone ambiguous queued group media
-- and external rows rejected by migration 020 before deleting their retained webhook payloads.
INSERT INTO telegram_ingress_ignored_updates (update_id, reason)
SELECT item.update_id, 'media_security_upgrade'
FROM telegram_ingress_updates AS item
WHERE (
    item.status IN ('pending', 'processing')
    OR item.last_error_code = 'AGENT_EXTERNAL_MEDIA_IGNORED'
  )
  AND item.payload #>> '{message,chat,type}' IN ('group', 'supergroup')
  AND (
    (item.payload -> 'message') ?| ARRAY[
      'animation',
      'audio',
      'document',
      'game',
      'gift',
      'live_photo',
      'new_chat_photo',
      'paid_media',
      'passport_data',
      'photo',
      'sticker',
      'story',
      'unique_gift',
      'video',
      'video_note',
      'voice'
    ]
    OR jsonb_path_exists(
      jsonb_build_array(
        item.payload #> '{message,chat_shared}',
        item.payload #> '{message,poll}',
        item.payload #> '{message,rich_message}',
        item.payload #> '{message,users_shared}'
      ),
      '$.**.file_id'
    )
  )
ON CONFLICT (update_id) DO NOTHING;

-- The tombstone now owns replay deduplication, so no message metadata or file identifiers remain.
DELETE FROM telegram_ingress_updates
WHERE update_id IN (SELECT update_id FROM telegram_ingress_ignored_updates);
