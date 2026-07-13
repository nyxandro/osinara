CREATE TABLE telegram_ingress_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  current_continuation_key text NOT NULL UNIQUE CHECK (char_length(current_continuation_key) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Aliases preserve one logical FIFO when Eve re-keys a Telegram group session to a new bot message.
CREATE TABLE telegram_ingress_continuation_aliases (
  continuation_key text PRIMARY KEY CHECK (char_length(continuation_key) > 0),
  queue_id uuid NOT NULL REFERENCES telegram_ingress_queues(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telegram_ingress_aliases_queue
  ON telegram_ingress_continuation_aliases (queue_id);

CREATE TABLE telegram_ingress_updates (
  update_id bigint PRIMARY KEY CHECK (update_id >= 0),
  queue_id uuid NOT NULL REFERENCES telegram_ingress_queues(id) ON DELETE RESTRICT,
  ingress_continuation_key text NOT NULL CHECK (char_length(ingress_continuation_key) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  dispatch_started_at timestamptz,
  eve_session_id text,
  voice_file_id text,
  voice_file_size bigint CHECK (voice_file_size > 0),
  voice_mime_type text,
  voice_transcript text,
  voice_transcription_started_at timestamptz,
  voice_transcribed_at timestamptz,
  last_error_code text,
  last_error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND eve_session_id IS NULL) OR
    (status IN ('pending', 'completed', 'failed') AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (voice_file_id IS NOT NULL OR (voice_file_size IS NULL AND voice_mime_type IS NULL)),
  CHECK (voice_file_id IS NOT NULL OR voice_transcription_started_at IS NULL),
  CHECK (voice_transcript IS NULL OR (voice_file_id IS NOT NULL AND char_length(voice_transcript) > 0)),
  CHECK (voice_transcript IS NULL OR voice_transcription_started_at IS NOT NULL),
  CHECK ((voice_transcript IS NULL) = (voice_transcribed_at IS NULL)),
  CHECK ((last_error_code IS NULL) = (last_error_message IS NULL)),
  CHECK (completed_at IS NULL OR status IN ('completed', 'failed'))
);

CREATE INDEX telegram_ingress_fifo
  ON telegram_ingress_updates (queue_id, update_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX telegram_ingress_claimable
  ON telegram_ingress_updates (update_id, lease_expires_at)
  WHERE status IN ('pending', 'processing');
