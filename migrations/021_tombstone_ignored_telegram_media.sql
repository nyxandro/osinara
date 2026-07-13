-- Payload-free tombstones prevent a rejected update_id from gaining trust after registration changes.
CREATE TABLE telegram_ingress_ignored_updates (
  update_id bigint PRIMARY KEY CHECK (update_id >= 0),
  reason text NOT NULL CHECK (char_length(reason) > 0),
  received_at timestamptz NOT NULL DEFAULT now()
);
