-- Гостевой доступ к агенту (#471, docs/plans/[07.11.2026]-guest-access.md).
--
-- Гость — участник своей отдельной «семьи из одного человека» без владельца: память, файлы, скиллы, напоминания и
-- Google разделяются той же границей `family_id`, что разделяет семьи. Эта таблица связывает гостя с семьёй
-- владельца, который его пригласил, и хранит, что владелец ему выключил. Удаление гостя закрывает доступ
-- (`status = 'revoked'` и удалённое членство в его семье), а данные остаются запечатанными в его семье.
ALTER TABLE invitations
  ADD COLUMN kind text NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'guest'));

CREATE TABLE guest_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guest_family_id uuid NOT NULL UNIQUE REFERENCES families(id) ON DELETE CASCADE,
  host_family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  -- Ссылка, по которой гость пришёл последним; удаление приглашений вместе с семьёй-хозяином не удаляет запись гостя.
  invitation_id uuid REFERENCES invitations(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  disabled_tools text[] NOT NULL DEFAULT '{}',
  disabled_skills text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT guest_accounts_separate_family CHECK (guest_family_id <> host_family_id),
  CONSTRAINT guest_accounts_revocation_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX guest_accounts_host_family ON guest_accounts (host_family_id, created_at);
