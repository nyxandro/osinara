-- #569: group memory is reviewed only in the background. An addressed group turn no longer binds the
-- unreviewed tail to itself as an `interactive` batch, and the code that prepared, finished and cleaned
-- up such batches is gone. This migration settles, once, what that code would have settled for the
-- batches alive at the switch. On production there were none on 2026-11-21; this is the guard for the
-- moment of the release.
--
-- A prepared interactive batch whose turn never started wrote nothing: a turn writes memory only after
-- `turn.started` binds it to the batch and to a source set. Its exact range becomes an ordinary pending
-- background batch: same lane, predecessor and sources, so nothing is reviewed twice and nothing is lost.
-- Such a range is short, and a short background batch is allowed only when it is released early;
-- `aged_release_at` records that release, which keeps the batch's ordinary retry before its turn
-- starts. The audit event names the hand-over.
--
-- A pre-2026-09 start ambiguity is converted under the integrity conditions the removed
-- `recoverUnstartedReviewBatches` checked on every dispatch, with the same recovery code. Its other
-- condition, a retired chat session, guarded against a chat turn still starting on the batch; no chat
-- turn takes a batch any more.
--
-- A batch bound to a started turn is left alone: the abandoned-turn bound settles it by provenance once
-- the turn ends, as it does for a background batch.

WITH retired AS (
  UPDATE memory_review_batches AS batch
     SET batch_kind = 'background', status = 'pending', application_session_id = NULL,
         preparation_entry_id = NULL, lease_token = NULL, lease_expires_at = NULL,
         diagnostic_code = NULL, started_at = NULL, completed_at = NULL,
         aged_release_at = now(), updated_at = now()
   WHERE batch.batch_kind = 'interactive' AND batch.status = 'running'
     AND batch.agent_session_id IS NULL AND batch.agent_turn_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = batch.id
     )
  RETURNING batch.id, batch.conversation_id, batch.source_count
)
INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT conversation.family_id, 'memory_review.recovered', retired.id,
       jsonb_build_object('diagnosticCode', 'AGENT_MEMORY_REVIEW_INTERACTIVE_RETIRED',
         'sourceCount', retired.source_count)
  FROM retired
  JOIN application_conversations AS conversation ON conversation.id = retired.conversation_id;

WITH recovered AS (
  UPDATE memory_review_batches AS batch
     SET batch_kind = 'background', status = 'pending', application_session_id = NULL,
         lease_token = NULL, lease_expires_at = NULL, diagnostic_code = NULL,
         started_at = NULL, completed_at = NULL, recovery_attempts = 1,
         last_recovery_diagnostic_code = 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS',
         last_recovered_at = now(), updated_at = now()
    FROM memory_review_lanes AS lane
   WHERE lane.id = batch.lane_id AND lane.conversation_id = batch.conversation_id
     AND batch.batch_kind = 'interactive' AND batch.status = 'ambiguous'
     AND batch.diagnostic_code = 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS'
     AND batch.recovery_attempts = 0
     AND batch.agent_session_id IS NULL AND batch.agent_turn_id IS NULL
     AND batch.predecessor_sequence >= lane.processed_through_sequence
     AND NOT EXISTS (
       SELECT 1 FROM memory_turn_source_sets WHERE memory_review_batch_id = batch.id
     )
     AND (SELECT count(*) FROM memory_review_batch_sources WHERE batch_id = batch.id) = batch.source_count
     AND (SELECT min(timeline_sequence) FROM memory_review_batch_sources WHERE batch_id = batch.id) = batch.from_sequence
     AND (SELECT max(timeline_sequence) FROM memory_review_batch_sources WHERE batch_id = batch.id) = batch.through_sequence
     AND NOT EXISTS (
       SELECT 1 FROM memory_review_batch_sources AS source
         JOIN telegram_group_messages AS message ON message.id = source.timeline_entry_id
        WHERE source.batch_id = batch.id AND (
          source.conversation_id <> batch.conversation_id OR
          message.conversation_id <> batch.conversation_id OR
          message.sequence_id <> source.timeline_sequence OR
          message.message_thread_id IS DISTINCT FROM lane.message_thread_id OR
          message.actor_kind NOT IN ('user', 'telegram_bot')
        )
     )
     AND NOT EXISTS (
       SELECT 1 FROM claim_evidence AS evidence
        WHERE evidence.origin_conversation_id = batch.conversation_id
          AND evidence.timeline_sequence BETWEEN batch.from_sequence AND batch.through_sequence
     )
  RETURNING batch.id, batch.conversation_id, batch.source_count
)
INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
SELECT conversation.family_id, 'memory_review.recovered', recovered.id,
       jsonb_build_object('diagnosticCode', 'AGENT_MEMORY_REVIEW_INTERACTIVE_START_AMBIGUOUS',
         'recoveryAttempt', 1, 'sourceCount', recovered.source_count)
  FROM recovered
  JOIN application_conversations AS conversation ON conversation.id = recovered.conversation_id;
