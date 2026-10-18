-- Скиллы семьи становятся общей библиотекой (решение владельца 18.10.2026): создать или скачать
-- скилл может любой член семьи, а включает его каждый у себя сам. Подтверждений кнопкой больше нет.
--
-- family_skills.author_user_id — кто завёл скилл: новую версию, откат и удаление делают автор и
-- владелец. Для уже существующих скиллов автор — создатель первой версии.
-- family_skill_activations — у кого из членов семьи скилл включён. Раньше включённый скилл работал
-- сразу у всех; теперь он остаётся включённым только у автора, остальные включат его себе сами.
-- Общий флаг family_skills.enabled уходит вместе с проверкой «включён только с рабочей версией».
--
-- Списки скиллов семейных групп хранятся там же, где списки внешних групп (skill_allowlist):
-- встроенные скиллы в семейной группе работают всегда, а скиллы семьи — только из этого списка.
-- Сейчас списки семейных групп пусты, так что скиллы семьи в них не работают, пока их не включат.
--
-- family_skill_notices — служебные сообщения о каждом изменении скиллов вместо кнопок: приложение
-- само отправляет их тому, кого изменение касается. Неоднозначная отправка не повторяется.
ALTER TABLE family_skills ADD COLUMN author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE family_skills skill
   SET author_user_id = first_version.created_by
  FROM (SELECT DISTINCT ON (skill_id) skill_id, created_by
          FROM family_skill_versions ORDER BY skill_id, version) first_version
 WHERE first_version.skill_id = skill.id;

CREATE TABLE family_skill_activations (
  skill_id uuid NOT NULL REFERENCES family_skills(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, user_id)
);
CREATE INDEX family_skill_activations_user_id ON family_skill_activations (user_id);

INSERT INTO family_skill_activations (skill_id, user_id)
SELECT id, author_user_id FROM family_skills
 WHERE enabled AND active_version IS NOT NULL AND author_user_id IS NOT NULL;

ALTER TABLE family_skills DROP COLUMN enabled;

CREATE TABLE family_skill_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  -- Одно изменение — одно сообщение каждому адресату, даже если ход повторили после сбоя.
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 300),
  recipient_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  recipient_group_id uuid REFERENCES telegram_groups(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 3500),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'ambiguous', 'failed')),
  delivery_token uuid,
  delivery_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_key),
  CHECK ((recipient_user_id IS NULL) <> (recipient_group_id IS NULL)),
  CHECK ((status = 'delivering') = (delivery_token IS NOT NULL))
);
CREATE INDEX family_skill_notices_pending ON family_skill_notices (created_at, id) WHERE status = 'pending';

-- «Сколько раз скилл загружали за 30 дней» считается по журналу вызовов: без индекса каждый список
-- скиллов читал бы весь журнал, который не чистится.
CREATE INDEX agent_tool_calls_load_skill_created_at ON agent_tool_calls (created_at) WHERE tool_name = 'load_skill';
