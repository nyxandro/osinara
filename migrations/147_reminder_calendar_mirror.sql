-- Напоминания в Google Календаре: двусторонняя связь напоминаний бота с отдельным календарём в
-- подключённом Google (docs/plans/reminders-google-calendar.md).
--
-- Профиль связи — один на подключённый профиль Google (личный или семейный workspace). Он хранит,
-- какой календарь ведёт бот, метку для поиска календаря после потерянного ответа Google, метку
-- последней сверки изменений и состояние связи. Настройка «вести или нет» людям не даётся: профиль
-- работает, пока подключён Google. Ссылка на аккаунт обнуляется при его удалении, чтобы при
-- переподключении того же аккаунта бот продолжил вести прежний календарь.
CREATE TYPE calendar_mirror_state AS ENUM (
  'active',
  'removing',
  'stopped_access_lost',
  'stopped_calendar_deleted',
  'stopped_calendar_refused'
);

CREATE TABLE calendar_mirror_profiles (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_account_id uuid REFERENCES integration_accounts(id) ON DELETE SET NULL,
  external_account_id text CHECK (char_length(external_account_id) BETWEEN 1 AND 320),
  calendar_id text CHECK (char_length(calendar_id) BETWEEN 1 AND 1024),
  calendar_marker text CHECK (char_length(calendar_marker) BETWEEN 1 AND 200),
  sync_token text CHECK (char_length(sync_token) BETWEEN 1 AND 4096),
  state calendar_mirror_state NOT NULL DEFAULT 'active',
  calendar_missing_since timestamptz,
  last_error_code text CHECK (char_length(last_error_code) BETWEEN 1 AND 100),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  next_attempt_at timestamptz,
  stop_notice_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Метка сверки относится к конкретному календарю и без него смысла не имеет.
  CHECK (calendar_id IS NOT NULL OR sync_token IS NULL)
);

CREATE INDEX calendar_mirror_profiles_due_idx
  ON calendar_mirror_profiles (next_attempt_at)
  WHERE integration_account_id IS NOT NULL;

-- Копия — событие календаря, связанное с напоминанием. `copy` без напоминания (удалено) ждёт
-- удаления события; `ignored` — событие человека, по которому напоминание не создано (сообщение
-- о причине уже отправлено). etag — версия события после последней записи или чтения ботом: другой
-- etag в сверке означает правку человека. pushed — вид копии, отправленный ботом: с ним сравнивается
-- событие, чтобы понять, что именно поменял человек.
CREATE TYPE calendar_mirror_copy_kind AS ENUM ('copy', 'ignored');

CREATE TABLE calendar_mirror_copies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES calendar_mirror_profiles(workspace_id) ON DELETE CASCADE,
  kind calendar_mirror_copy_kind NOT NULL,
  reminder_id uuid UNIQUE REFERENCES reminders(id) ON DELETE SET NULL,
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 5 AND 1024),
  etag text CHECK (char_length(etag) BETWEEN 1 AND 200),
  event_updated timestamptz,
  fingerprint text CHECK (char_length(fingerprint) = 64),
  pushed jsonb CHECK (pushed IS NULL OR jsonb_typeof(pushed) = 'object'),
  series_start_local timestamp,
  shown boolean NOT NULL DEFAULT false,
  rejected_fingerprint text CHECK (char_length(rejected_fingerprint) = 64),
  last_error_code text CHECK (char_length(last_error_code) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, event_id),
  CHECK (kind = 'copy' OR reminder_id IS NULL)
);

-- Служебное сообщение о связи с календарём видно модели в истории, как доставленные напоминания.
ALTER TYPE proactive_delivery_source_kind ADD VALUE 'calendar_mirror_notice';

-- Уже подключённые профили Google получают связь сразу: настройки «вести или нет» нет.
INSERT INTO calendar_mirror_profiles (workspace_id, integration_account_id, external_account_id)
SELECT account.workspace_id, account.id, account.external_account_id
FROM integration_accounts AS account
JOIN workspaces AS workspace ON workspace.id = account.workspace_id
WHERE account.provider = 'google_workspace' AND account.is_default AND account.status = 'active'
  AND workspace.scope IN ('personal', 'family')
ON CONFLICT (workspace_id) DO NOTHING;
