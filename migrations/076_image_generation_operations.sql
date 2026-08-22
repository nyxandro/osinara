CREATE TABLE image_generation_operations (
  operation_key text PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  output_path text NOT NULL CHECK (char_length(output_path) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed', 'ambiguous')),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]+$'),
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

CREATE INDEX image_generation_operations_workspace
  ON image_generation_operations (workspace_id, created_at DESC);
