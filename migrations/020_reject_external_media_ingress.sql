-- Legacy non-terminal external media must not gain family trust after a group type change.
UPDATE telegram_ingress_updates AS item
SET status = 'failed',
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error_code = 'AGENT_EXTERNAL_MEDIA_IGNORED',
    last_error_message = 'Входящие документы и медиафайлы во внешних группах не обрабатываются',
    completed_at = now(),
    updated_at = now()
FROM telegram_groups AS group_row
WHERE group_row.telegram_chat_id = item.payload #>> '{message,chat,id}'
  AND group_row.type IN ('external_private', 'external_public')
  AND item.status IN ('pending', 'processing')
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
  );
