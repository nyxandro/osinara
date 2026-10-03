-- Идентификаторы хода и сессии ядра получают собственные имена: колонки `eve_session_id` /
-- `eve_turn_id` становятся `agent_session_id` / `agent_turn_id`, ограничения и индексы с прежним
-- словом в имени переименовываются. Значения и связи не меняются; функций и представлений,
-- читающих эти колонки по имени, в схеме нет.
--
-- Удаляются остатки прежнего ядра и снятого вместе с ним ручного пути отмены сообщений Telegram:
-- курсоры событий сессий, журнал операторской команды отмены (её больше нет), флаг запроса отмены
-- и счётчик попыток восстановления. Сессии, перенесённые в v0.35, помечаются `imported`.

ALTER TABLE agent_schedule_runs RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE agent_schedule_runs RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE conversation_sessions RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_extraction_batches RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_mutation_operations RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_mutation_operations RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE memory_retrieval_shows RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_retrieval_turns RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_review_batches RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_review_batches RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE memory_turn_source_sets RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_turn_source_sets RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE memory_turn_sources RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE memory_turn_sources RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE profile_views RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE profile_views RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE runtime_admission_holders RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE telegram_final_deliveries RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE telegram_final_deliveries RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE telegram_hitl_approvals RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE telegram_hitl_approvals RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE telegram_ingress_updates RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE telegram_ingress_wakeups RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE telegram_progress_notices RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE telegram_progress_notices RENAME COLUMN eve_turn_id TO agent_turn_id;
ALTER TABLE telegram_turn_interjections RENAME COLUMN eve_session_id TO agent_session_id;
ALTER TABLE telegram_turn_interjections RENAME COLUMN eve_turn_id TO agent_turn_id;

ALTER TABLE conversation_sessions
  RENAME CONSTRAINT conversation_sessions_eve_session_id_key TO conversation_sessions_agent_session_id_key;
ALTER TABLE telegram_hitl_approvals
  RENAME CONSTRAINT telegram_hitl_approvals_application_session_id_eve_session__key
  TO telegram_hitl_approvals_session_request_key;
ALTER TABLE memory_extraction_batches
  RENAME CONSTRAINT memory_extraction_batches_eve_session_id_check TO memory_extraction_batches_agent_session_id_check;
ALTER TABLE profile_views RENAME CONSTRAINT profile_views_eve_turn_shape TO profile_views_agent_turn_shape;
ALTER TABLE telegram_final_deliveries
  RENAME CONSTRAINT telegram_final_deliveries_eve_session_id_check TO telegram_final_deliveries_agent_session_id_check;
ALTER TABLE telegram_final_deliveries
  RENAME CONSTRAINT telegram_final_deliveries_eve_session_turn_key TO telegram_final_deliveries_agent_session_turn_key;
ALTER TABLE telegram_final_deliveries
  RENAME CONSTRAINT telegram_final_deliveries_eve_turn_id_check TO telegram_final_deliveries_agent_turn_id_check;
ALTER TABLE memory_turn_source_sets
  RENAME CONSTRAINT memory_turn_source_sets_eve_session_id_eve_turn_id_conversa_key
  TO memory_turn_source_sets_agent_session_turn_conversation_key;
ALTER TABLE memory_turn_sources
  RENAME CONSTRAINT memory_turn_sources_eve_session_id_eve_turn_id_conversatio_fkey
  TO memory_turn_sources_agent_session_turn_conversation_fkey;
ALTER TABLE memory_turn_sources
  RENAME CONSTRAINT memory_turn_sources_eve_session_id_eve_turn_id_timeline_seq_key
  TO memory_turn_sources_agent_session_turn_timeline_seq_key;
ALTER TABLE memory_review_batches
  RENAME CONSTRAINT memory_review_batches_eve_session_id_check TO memory_review_batches_agent_session_id_check;
ALTER TABLE memory_review_batches
  RENAME CONSTRAINT memory_review_batches_eve_turn_id_check TO memory_review_batches_agent_turn_id_check;
ALTER TABLE telegram_progress_notices
  RENAME CONSTRAINT telegram_progress_notices_eve_session_id_check TO telegram_progress_notices_agent_session_id_check;
ALTER TABLE telegram_progress_notices
  RENAME CONSTRAINT telegram_progress_notices_eve_session_id_eve_turn_id_step_i_key
  TO telegram_progress_notices_agent_session_turn_step_key;
ALTER TABLE telegram_progress_notices
  RENAME CONSTRAINT telegram_progress_notices_eve_turn_id_check TO telegram_progress_notices_agent_turn_id_check;
ALTER TABLE memory_retrieval_shows
  RENAME CONSTRAINT memory_retrieval_shows_eve_session_id_check TO memory_retrieval_shows_agent_session_id_check;
ALTER TABLE memory_retrieval_turns
  RENAME CONSTRAINT memory_retrieval_turns_eve_session_id_check TO memory_retrieval_turns_agent_session_id_check;
ALTER TABLE telegram_turn_interjections
  RENAME CONSTRAINT telegram_turn_interjections_eve_session_id_check TO telegram_turn_interjections_agent_session_id_check;
ALTER TABLE telegram_turn_interjections
  RENAME CONSTRAINT telegram_turn_interjections_eve_turn_id_check TO telegram_turn_interjections_agent_turn_id_check;

ALTER INDEX agent_schedule_runs_eve_session_idx RENAME TO agent_schedule_runs_agent_session_idx;
ALTER INDEX memory_review_batches_eve_session RENAME TO memory_review_batches_agent_session;
ALTER INDEX memory_review_batches_eve_turn RENAME TO memory_review_batches_agent_turn;
ALTER INDEX profile_views_eve_turn RENAME TO profile_views_agent_turn;

ALTER TABLE agent_session_state DROP CONSTRAINT agent_session_state_source_check;
UPDATE agent_session_state SET source = 'imported' WHERE source = 'eve_import';
ALTER TABLE agent_session_state
  ADD CONSTRAINT agent_session_state_source_check CHECK (source IN ('runtime', 'imported'));

DROP TABLE eve_session_event_cursors;
DROP TABLE telegram_ingress_recovery_events;
ALTER TABLE telegram_ingress_updates DROP COLUMN recovery_cancel_requested;
ALTER TABLE telegram_ingress_updates DROP COLUMN recovery_attempts;
