-- Whom a memory record is about, by its binding instead of by the text the model wrote (#556).
--
-- A record about a person is bound to a conversation participant (group memory) or to a family
-- member's account (family and personal memory). The model used to see only the record's text, so a
-- namesake, a changed username or a record that names nobody left it guessing. From here on every
-- path that shows a record, the search that lowers other people's records (#343) and the vector header
-- (#193) read the person through `memory_subject_person`.
--
-- Re-runnable: the integration test applies this file again over prepared rows.

ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS username_snapshot text;

COMMENT ON COLUMN conversation_participants.username_snapshot IS
  'Telegram username of the participant as of their latest observed message in this conversation; NULL when that message carried none.';

-- The group journal keeps only its newest messages, so for half of the participants of a busy group it
-- holds nothing. The raw updates are kept from the first day, and the latest one a person sent to this
-- chat carries their username as of then; an update without one means they had none.
WITH latest AS (
  SELECT DISTINCT ON (ingress.payload->'message'->'chat'->>'id', ingress.payload->'message'->'from'->>'id')
         ingress.payload->'message'->'chat'->>'id' AS telegram_chat_id,
         ingress.payload->'message'->'from'->>'id' AS telegram_user_id,
         ingress.payload->'message'->'from'->>'username' AS username
  FROM telegram_ingress_updates AS ingress
  WHERE ingress.payload->'message'->'from'->>'id' IS NOT NULL
  ORDER BY ingress.payload->'message'->'chat'->>'id', ingress.payload->'message'->'from'->>'id',
           ingress.update_id DESC
)
UPDATE conversation_participants AS participant
SET username_snapshot = latest.username
FROM application_conversations AS conversation, latest
WHERE conversation.id = participant.conversation_id
  AND latest.telegram_chat_id = conversation.telegram_chat_id
  AND latest.telegram_user_id = participant.telegram_user_id
  AND participant.username_snapshot IS DISTINCT FROM latest.username;

-- The person a record is about, as they are named now, and their Telegram id (search never lowers the
-- asker's own records). A participant is named by its own row: group memory stays inside its chat. A
-- family member is named by their newest participant row in a family or personal chat — their own
-- name and username, the same in every chat — and by the account itself when there is none yet.
CREATE OR REPLACE FUNCTION memory_subject_person(subject_participant_id uuid, subject_user_id uuid)
RETURNS TABLE (name text, username text, telegram_user_id text)
LANGUAGE sql STABLE AS $$
  SELECT participant.display_name_snapshot, participant.username_snapshot, participant.telegram_user_id
  FROM conversation_participants AS participant
  WHERE participant.id = subject_participant_id
  UNION ALL
  SELECT CASE WHEN participant.id IS NULL THEN app_user.display_name ELSE participant.display_name_snapshot END,
         CASE WHEN participant.id IS NULL THEN app_user.telegram_username ELSE participant.username_snapshot END,
         app_user.telegram_user_id
  FROM users AS app_user
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.display_name_snapshot, candidate.username_snapshot
    FROM conversation_participants AS candidate
    WHERE candidate.linked_user_id = app_user.id AND candidate.scope IN ('family', 'personal')
    ORDER BY candidate.last_observed_at DESC, candidate.id
    LIMIT 1
  ) AS participant ON true
  WHERE app_user.id = subject_user_id AND subject_participant_id IS NULL
$$;

-- «Indexing stalled» means records that semantic search cannot find yet. A queued re-index of a record
-- that has its vector is not that: it keeps serving the whole time, and the 3 103 jobs below would
-- otherwise hold the oldest-pending age up for as long as the rebuild takes and raise
-- OsinaraMemoryIndexingStalled for nothing. The view keeps its columns, so the exporter is unchanged.
CREATE OR REPLACE VIEW monitoring_memory_embedding_backlog AS
  SELECT count(*) AS pending,
         COALESCE(EXTRACT(EPOCH FROM (now() - min(job.created_at)))::bigint, 0)
           AS oldest_pending_age_seconds
  FROM memory_embedding_jobs AS job
  JOIN memory_items_all AS item ON item.id = job.memory_item_id
  WHERE job.status IN ('pending', 'leased') AND item.embedding_status <> 'indexed';

-- The owner chose to rebuild every bound record's vector at once (20.11.2026): without it the header
-- names the person only on records written from now on. The old vector serves until the new one
-- replaces it in the same transaction, so search keeps working while the queue drains.
INSERT INTO memory_embedding_jobs (memory_item_id)
SELECT item.id
FROM memory_items AS item
WHERE item.claim_status = 'active'
  AND (item.subject_participant_id IS NOT NULL OR item.subject_user_id IS NOT NULL)
ON CONFLICT (memory_item_id) DO UPDATE
SET status = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL,
    last_error_code = NULL, updated_at = now();
