-- One row per model tool call that may spend ElevenLabs credits on an outbound voice message.
CREATE TABLE voice_message_operations (
  operation_key text PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  -- Historical idempotency state must outlive deletion of the workspace and its files.
  workspace_id uuid NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  output_path text NOT NULL CHECK (char_length(output_path) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed', 'ambiguous')),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]+$'),
  character_cost integer CHECK (character_cost IS NULL OR character_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'started' AND result IS NULL AND error_code IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND result IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL)
    OR
    (status IN ('failed', 'ambiguous') AND result IS NULL AND error_code IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX voice_message_operations_workspace
  ON voice_message_operations (workspace_id, created_at DESC);

-- A synthesized voice note travels through the same exactly-once workspace file delivery ledger.
ALTER TABLE workspace_file_deliveries
  DROP CONSTRAINT workspace_file_deliveries_presentation_check;

ALTER TABLE workspace_file_deliveries
  ADD CONSTRAINT workspace_file_deliveries_presentation_check
  CHECK (presentation IN ('document', 'photo', 'voice'));
