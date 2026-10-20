-- Разрешения на доступ из песочниц семьи к IP-адресам: домашние устройства (Home Assistant, NAS,
-- роутер), адреса Tailscale, нестандартные порты (решение владельца 20.10.2026). Выдаёт только
-- владелец кнопкой подтверждения, отзывает тоже он.
--
-- Фильтр песочниц не ходит в базу: приложение после каждого изменения и при старте пересобирает из
-- этой таблицы файл действующих разрешений в общем томе, а фильтр читает его на каждый запрос.
-- Песочницы семьи делят одну сеть, и фильтр не различает, чья это песочница, поэтому один адрес и
-- порт действует не больше одного раза на весь сервер.
CREATE TABLE network_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  address inet NOT NULL CHECK (family(address) = 4 AND masklen(address) = 32),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  -- Что за устройство по этому адресу: владелец видит это в карточке подтверждения и в списке.
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 200),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Повтор хода после сбоя не создаёт второе разрешение.
  operation_key text NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX network_access_grants_active_destination
  ON network_access_grants (address, port) WHERE revoked_at IS NULL;
