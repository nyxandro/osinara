CREATE TYPE shopping_list_status AS ENUM ('active', 'archived');
CREATE TYPE shopping_item_status AS ENUM ('pending', 'purchased');

CREATE TABLE shopping_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status shopping_list_status NOT NULL DEFAULT 'active',
  telegram_chat_id text NOT NULL,
  message_thread_id bigint CHECK (message_thread_id > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shopping_lists_family_idx
  ON shopping_lists (family_id, status, updated_at DESC, id DESC);

CREATE TABLE shopping_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  quantity text CHECK (quantity IS NULL OR char_length(quantity) BETWEEN 1 AND 100),
  status shopping_item_status NOT NULL DEFAULT 'pending',
  purchased_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  purchased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND purchased_by_user_id IS NULL AND purchased_at IS NULL) OR
    (status = 'purchased' AND purchased_by_user_id IS NOT NULL AND purchased_at IS NOT NULL)
  )
);

CREATE INDEX shopping_items_list_idx
  ON shopping_items (list_id, status, created_at, id);

CREATE TABLE shopping_operations (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  operation_kind text NOT NULL CHECK (
    operation_kind IN ('create_list', 'update_list', 'delete_list', 'add_item', 'update_item', 'delete_item')
  ),
  input_hash text NOT NULL CHECK (char_length(input_hash) = 64),
  list_id uuid REFERENCES shopping_lists(id) ON DELETE SET NULL,
  item_id uuid REFERENCES shopping_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, operation_key)
);
