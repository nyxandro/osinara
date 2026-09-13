-- The answered request may belong to the previous conversation turn; keep it separate from execution.
ALTER TABLE telegram_ingress_updates ADD COLUMN response_session_id text, ADD COLUMN response_turn_id text,
  ADD COLUMN response_start_index bigint CHECK(response_start_index>=0);
ALTER TABLE telegram_ingress_updates ADD CONSTRAINT telegram_response_coordinates CHECK (
  (response_session_id IS NULL AND response_turn_id IS NULL AND response_start_index IS NULL) OR
  (response_session_id IS NOT NULL AND response_turn_id IS NOT NULL AND response_start_index IS NOT NULL)
);
