-- История группы ограничена, и при записи нового сообщения самые старые удаляются в той же
-- транзакции. Внешний ключ claim_evidence при этом обнуляет timeline_entry_id — это UPDATE строки
-- доказательства. Триггер личности доказательства перепроверял на любом UPDATE обе свои проверки,
-- и служебное обнуление ссылки падало, если память к этому времени мягко удалена (представление
-- memory_items её уже не видит) или участник-автор позже привязался к пользователю. Откат уносил и
-- новое сообщение: группа переставала принимать сообщения совсем (#306).
--
-- Обе проверки охраняют то, к чему доказательство прикреплено: к какому заявлению и от какого
-- автора. Поэтому они выполняются, когда пишутся эти колонки, а не при смене посторонней, как
-- ссылка на исходное сообщение. Прикрепить доказательство к удалённой памяти по-прежнему нельзя.
CREATE OR REPLACE FUNCTION validate_claim_evidence_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_user uuid;
  claim_provenance memory_provenance_state;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.claim_id IS DISTINCT FROM OLD.claim_id THEN
    SELECT provenance_state INTO claim_provenance FROM memory_items WHERE id = NEW.claim_id;
    IF claim_provenance IS DISTINCT FROM 'evidenced'::memory_provenance_state THEN
      RAISE EXCEPTION 'AGENT_CLAIM_EVIDENCE_PROVENANCE_INVALID: claim must be evidenced';
    END IF;
  END IF;

  IF NEW.author_participant_id IS NOT NULL AND (
    TG_OP = 'INSERT'
    OR NEW.author_participant_id IS DISTINCT FROM OLD.author_participant_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
  ) THEN
    SELECT linked_user_id INTO linked_user
    FROM conversation_participants
    WHERE id = NEW.author_participant_id;
    IF NEW.author_user_id IS DISTINCT FROM linked_user THEN
      RAISE EXCEPTION 'AGENT_CLAIM_EVIDENCE_AUTHOR_LINK_INVALID: author user link is not exact';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
