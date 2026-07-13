CREATE TABLE software_update_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  expected_owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expected_owner_telegram_user_id text NOT NULL CHECK (
    char_length(expected_owner_telegram_user_id) > 0
  ),
  target_version text NOT NULL UNIQUE CHECK (
    target_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  release_url text NOT NULL CHECK (
    release_url LIKE 'https://github.com/nyxandro/osinara/releases/tag/v%'
  ),
  manifest jsonb NOT NULL CHECK (
    jsonb_typeof(manifest) = 'object'
    AND manifest ?& ARRAY['schemaVersion', 'version', 'commitSha', 'composeSha256', 'images']
    AND manifest - ARRAY['schemaVersion', 'version', 'commitSha', 'composeSha256', 'images'] = '{}'::jsonb
    AND jsonb_typeof(manifest->'schemaVersion') = 'number'
    AND jsonb_typeof(manifest->'version') = 'string'
    AND jsonb_typeof(manifest->'commitSha') = 'string'
    AND jsonb_typeof(manifest->'composeSha256') = 'string'
    AND jsonb_typeof(manifest->'images') = 'object'
    AND manifest->>'version' = target_version
    AND manifest->>'schemaVersion' = '1'
    AND manifest->>'commitSha' ~ '^[0-9a-f]{40}$'
    AND manifest->>'composeSha256' ~ '^[0-9a-f]{64}$'
  ),
  callback_token_hash text NOT NULL UNIQUE CHECK (
    callback_token_hash ~ '^[0-9a-f]{64}$'
  ),
  status text NOT NULL DEFAULT 'preparing' CHECK (status IN (
    'preparing',
    'pending',
    'approved',
    'declined',
    'delivery_failed',
    'delivery_ambiguous',
    'superseded',
    'deploying',
    'succeeded',
    'failed',
    'ambiguous'
  )),
  telegram_chat_id text,
  telegram_chat_type text CHECK (telegram_chat_type IS NULL OR telegram_chat_type = 'private'),
  telegram_message_id bigint CHECK (telegram_message_id > 0),
  decision_id uuid UNIQUE,
  decision_callback_query_id text UNIQUE,
  deployment_lease_token uuid,
  deployment_lease_expires_at timestamptz,
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  result_error_code text,
  result_error_message text,
  decision_ui_error_code text,
  decision_ui_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  placeholder_sent_at timestamptz,
  pending_at timestamptz,
  decided_at timestamptz,
  superseded_at timestamptz,
  deployment_started_at timestamptz,
  completed_at timestamptz,
  decision_ui_failed_at timestamptz,
  UNIQUE (telegram_chat_id, telegram_message_id),
  CHECK (
    (telegram_chat_id IS NULL AND telegram_chat_type IS NULL AND telegram_message_id IS NULL)
    OR
    (telegram_chat_id IS NOT NULL AND telegram_chat_type = 'private' AND telegram_message_id IS NOT NULL)
  ),
  CHECK (
    (status = 'preparing' AND telegram_message_id IS NULL)
    OR
    (status <> 'preparing')
  ),
  CHECK (
    (status IN ('approved', 'declined', 'deploying', 'succeeded', 'failed', 'ambiguous')
      AND decision_id IS NOT NULL
      AND decision_callback_query_id IS NOT NULL AND decided_at IS NOT NULL)
    OR
    (status NOT IN ('approved', 'declined', 'deploying', 'succeeded', 'failed', 'ambiguous')
      AND decision_id IS NULL AND decision_callback_query_id IS NULL AND decided_at IS NULL)
  ),
  CHECK (
    status NOT IN ('pending', 'approved', 'declined', 'deploying', 'succeeded', 'failed', 'ambiguous')
    OR (telegram_message_id IS NOT NULL AND pending_at IS NOT NULL)
  ),
  CHECK (
    status NOT IN (
      'delivery_failed', 'delivery_ambiguous', 'superseded', 'succeeded', 'failed', 'ambiguous'
    )
    OR completed_at IS NOT NULL
  ),
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CHECK (
    (status = 'deploying'
      AND deployment_lease_token IS NOT NULL
      AND deployment_lease_expires_at IS NOT NULL
      AND deployment_started_at IS NOT NULL
      AND deployment_lease_expires_at > deployment_started_at)
    OR
    (status <> 'deploying'
      AND deployment_lease_token IS NULL
      AND deployment_lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('deploying', 'succeeded', 'failed', 'ambiguous'))
      = (deployment_started_at IS NOT NULL)
  ),
  CHECK ((result_error_code IS NULL) = (result_error_message IS NULL)),
  CHECK ((decision_ui_error_code IS NULL) = (decision_ui_error_message IS NULL)),
  CHECK (decision_ui_failed_at IS NULL OR decision_ui_error_code IS NOT NULL)
);

CREATE INDEX software_update_proposals_approved
  ON software_update_proposals (decided_at, id)
  WHERE status = 'approved';
