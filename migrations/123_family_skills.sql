-- Скиллы семьи: владелец добавляет их сам, рядом со встроенными скиллами релиза.
--
-- family_skills — один скилл семьи под своим именем: включён ли он и какая версия работает.
-- family_skill_versions — каждая проверенная версия пакета. Новая версия сначала только
-- сохраняется и ждёт кнопки владельца; работающая версия меняется одной записью active_version,
-- поэтому старая продолжает работать до подтверждения и остаётся для отката.
-- Таблицы только добавляются: прежняя версия приложения их не читает.
CREATE TABLE family_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  enabled boolean NOT NULL DEFAULT false,
  active_version integer CHECK (active_version IS NULL OR active_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, name),
  CHECK (NOT enabled OR active_version IS NOT NULL)
);

CREATE TABLE family_skill_versions (
  skill_id uuid NOT NULL REFERENCES family_skills(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  description text NOT NULL CHECK (char_length(description) > 0),
  license text,
  markdown text NOT NULL,
  -- [{ "path", "size", "executable", "content" (base64) }], пути без SKILL.md.
  files jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  origin_kind text NOT NULL CHECK (origin_kind IN ('authored', 'downloaded')),
  origin_url text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version),
  CHECK ((origin_kind = 'downloaded') = (origin_url IS NOT NULL))
);

ALTER TABLE family_skills
  ADD CONSTRAINT family_skills_active_version_exists
  FOREIGN KEY (id, active_version) REFERENCES family_skill_versions (skill_id, version) DEFERRABLE INITIALLY DEFERRED;
