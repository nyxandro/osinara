-- Что модель уже видела в этой сессии: записи памяти в автоподборке и карточка автора.
-- Показанное недавно не подкладывается снова, иначе одни и те же три факта крутятся в каждом ходу.
CREATE TABLE memory_context_exposures (
  application_session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  memory_ref text NOT NULL,
  session_turn integer NOT NULL CHECK (session_turn >= 0),
  shows integer NOT NULL DEFAULT 1 CHECK (shows >= 1),
  last_shown_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_session_id, memory_ref)
);

CREATE TABLE profile_author_exposures (
  application_session_id uuid NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  session_turn integer NOT NULL CHECK (session_turn >= 0),
  last_shown_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_session_id, telegram_user_id)
);
