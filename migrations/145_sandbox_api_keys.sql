-- Ключи API для скиллов в песочницах (решение владельца 01.11.2026). Ключ приходит владельцу не
-- через модель: инструмент открывает ожидание, и следующее сообщение владельца в личке backend
-- перехватывает до очереди, шифрует и удаляет из чата. В песочницу попадает только заглушка; фильтр
-- песочниц подставляет настоящий ключ в заголовок запроса и отправляет его только на адрес сервиса
-- этого ключа. Фильтр не ходит в базу: приложение пересобирает из этих таблиц файл в общем томе.
CREATE TABLE sandbox_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  -- Из имени получаются переменные песочницы: neuraldeep → NEURALDEEP_API_KEY и NEURALDEEP_BASE_URL.
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,31}$'),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 200),
  -- Единственный адрес, куда уходит ключ: только HTTPS на стандартном порту.
  upstream_base_url text NOT NULL CHECK (
    upstream_base_url ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]*[a-z][a-z0-9-]*(/[^?#[:space:]]*[^/?#[:space:]])?$'
    AND char_length(upstream_base_url) <= 300
  ),
  -- Заголовки, задающие сам запрос, ключ не несут: проверка совпадает с той, что применяет фильтр.
  auth_header text NOT NULL CHECK (
    auth_header ~ '^[a-z][a-z0-9-]{0,63}$' AND auth_header NOT IN (
      'connection', 'content-length', 'content-type', 'host', 'keep-alive', 'proxy-authenticate',
      'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
    )
  ),
  auth_scheme text NOT NULL CHECK (auth_scheme IN ('bearer', 'raw')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Значение зашифровано AES-256-GCM ключом интеграций; пусто, пока владелец его не прислал.
  value_ciphertext text,
  value_nonce text,
  value_auth_tag text,
  value_stored_at timestamptz,
  -- Обновление Telegram, которое принесло значение: его повторная доставка не уйдёт модели.
  value_update_id text,
  -- Ожидание значения в личном чате владельца: до intake_expires_at следующее сообщение-ключ
  -- сохраняется, а до intake_guard_until сообщение, похожее на ключ, удаляется и не уходит модели —
  -- так ключ, присланный поздно или повторно, не попадёт в историю.
  intake_chat_id text,
  intake_expires_at timestamptz,
  intake_guard_until timestamptz,
  UNIQUE (family_id, name),
  CHECK (
    (value_ciphertext IS NULL AND value_nonce IS NULL AND value_auth_tag IS NULL AND value_stored_at IS NULL
      AND value_update_id IS NULL) OR
    (value_ciphertext IS NOT NULL AND value_nonce IS NOT NULL AND value_auth_tag IS NOT NULL
      AND value_stored_at IS NOT NULL AND value_update_id IS NOT NULL)
  ),
  CHECK (
    (intake_chat_id IS NULL AND intake_expires_at IS NULL AND intake_guard_until IS NULL) OR
    (intake_chat_id IS NOT NULL AND intake_expires_at IS NOT NULL AND intake_guard_until >= intake_expires_at)
  )
);
-- Одно ожидание на чат: следующее сообщение однозначно относится к одному ключу.
CREATE UNIQUE INDEX sandbox_api_keys_open_intake ON sandbox_api_keys (intake_chat_id)
  WHERE intake_chat_id IS NOT NULL;
CREATE UNIQUE INDEX sandbox_api_keys_value_update ON sandbox_api_keys (value_update_id)
  WHERE value_update_id IS NOT NULL;

-- Кому выдан ключ: личный workspace владельца, семейный или workspace внешней группы. У каждой
-- выдачи своя заглушка, и фильтр принимает её только из сети этого workspace.
CREATE TABLE sandbox_api_key_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid NOT NULL REFERENCES sandbox_api_keys(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  placeholder text NOT NULL UNIQUE CHECK (placeholder ~ '^osk_[A-Za-z0-9_-]{43}$'),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX sandbox_api_key_grants_active ON sandbox_api_key_grants (key_id, workspace_id)
  WHERE revoked_at IS NULL;
CREATE INDEX sandbox_api_key_grants_workspace ON sandbox_api_key_grants (workspace_id)
  WHERE revoked_at IS NULL;

-- Учёт: каждый запрос через ключ. Идентификатор даёт фильтр, поэтому повторная отправка пачки
-- после обрыва связи не считает запрос дважды. Лимитов нет по решению владельца — только учёт.
CREATE TABLE sandbox_api_key_usage (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES sandbox_api_key_grants(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL,
  -- Ответ сервиса; пусто, если сервис не ответил.
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sandbox_api_key_usage_grant ON sandbox_api_key_usage (grant_id, used_at);
