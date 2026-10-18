-- Факт о человеке привязывается к нему одним из двух способов: ссылкой на его проверенный Telegram-
-- аккаунт или текстовой подписью. Фоновая проверка группы часто подписывала текстом даже автора того
-- самого сообщения, из которого взят факт: «Пух (nyxandro)», «Brain4Qs», «@shimaoz». Подпись — строка,
-- а не личность: такие факты не попадали в карточку человека, а проверка похожих записей перед
-- сохранением не сравнивала их с проверенными записями о нём, потому что сравнивает один субъект за
-- раз. С этого выпуска сервер сам привязывает такую подпись к автору при записи
-- (`agent/lib/memory-subject-author-label.ts`); здесь то же правило применяется к уже сохранённым.
-- В группе автор — участник чата; в личной и семейной памяти — пользователь, как и для
-- current_author, причём в личной памяти это может быть только сам её владелец.
--
-- Автор берётся из доказательства записи (claim_evidence): там он подтверждён Telegram. Подпись
-- считается его именем, только если она ничего больше не говорит, без учёта регистра и лишних
-- пробелов:
-- - username автора, @username или «имя (username)»: username уникален, это всегда автор;
-- - одно имя автора — только если ни у кого другого в этом чате нет такого же имени, иначе подпись
--   может означать любого из них.
-- Имя берётся из снимка в доказательстве, из сообщения и из карточки участника. Username — любой из
-- известных у этого аккаунта: из исходного сообщения, из последнего сохранённого сообщения (исходное
-- могло быть удалено по сроку хранения) или из профиля пользователя. Подпись о другом человеке,
-- прозвище, которого нет в сообщении, или автор с темой («Пух (nyxandro) — Mastra») остаются текстом.
-- Не трогаются удалённые записи и записи проектных и предметных нитей.
--
-- Привязанная запись попадает в карточку на тех же условиях, что и новая: проверенный источник и
-- обычная чувствительность. Её вектор для поиска был построен с подписью в заголовке, поэтому она
-- ставится в очередь на пересчёт; до пересчёта она остаётся в поиске со старым вектором. updated_at
-- не меняется: текст не правился, а модель читает updatedAt как правку текста. Прежняя подпись каждой
-- привязанной записи остаётся в audit_events (memory.subject_label_rebound), чтобы привязку можно
-- было разобрать и отменить без бэкапа.
--
-- На проде 17.10.2026 по этому правилу привязывались 1 203 групповые записи о 125 людях; записей
-- личной и семейной памяти — ни одной.
WITH latest_username AS (
  SELECT DISTINCT ON (telegram_user_id) telegram_user_id, sender_username
  FROM telegram_group_messages
  WHERE telegram_user_id IS NOT NULL AND sender_username IS NOT NULL
  ORDER BY telegram_user_id, sent_at DESC, sequence_id DESC
), named AS (
  SELECT item.id, item.family_id, item.scope, item.subject_label, item.origin_conversation_id,
         evidence.author_participant_id, evidence.author_user_id,
         lower(btrim(regexp_replace(normalize(item.subject_label, NFKC), '\s+', ' ', 'g'))) AS label,
         ARRAY(
           SELECT lower(btrim(regexp_replace(normalize(name, NFKC), '\s+', ' ', 'g')))
           FROM unnest(ARRAY[evidence.author_label_snapshot, message.sender_display_name,
                             participant.display_name_snapshot]) AS name
           WHERE btrim(coalesce(name, '')) <> ''
         ) AS display_names,
         ARRAY(
           SELECT regexp_replace(lower(btrim(normalize(username, NFKC))), '^@', '')
           FROM unnest(ARRAY[message.sender_username, latest_username.sender_username,
                             account.telegram_username]) AS username
           WHERE btrim(coalesce(username, '')) <> ''
         ) AS usernames
  FROM memory_items_all AS item
  -- A claim has exactly one primary evidence row (unique index claim_evidence_one_primary).
  JOIN claim_evidence AS evidence
    ON evidence.claim_id = item.id AND evidence.evidence_role = 'primary'
  JOIN conversation_participants AS participant
    ON participant.id = evidence.author_participant_id
   AND participant.conversation_id = item.origin_conversation_id
  LEFT JOIN telegram_group_messages AS message ON message.id = evidence.timeline_entry_id
  LEFT JOIN latest_username ON latest_username.telegram_user_id = participant.telegram_user_id
  LEFT JOIN users AS account ON account.telegram_user_id = participant.telegram_user_id
  WHERE item.deleted_at IS NULL
    AND (item.scope = 'group' OR (
      evidence.author_user_id IS NOT NULL
      AND (item.scope <> 'personal' OR evidence.author_user_id = item.owner_user_id)
    ))
    AND item.subject_label IS NOT NULL
    AND num_nonnulls(item.subject_participant_id, item.subject_user_id, item.subject_family_id) = 0
    AND item.memory_project_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM memory_thread_entries AS entry WHERE entry.source_claim_id = item.id)
), candidate AS (
  SELECT named.* FROM named
  WHERE named.label <> ''
    AND (
      EXISTS (
        SELECT 1 FROM unnest(named.usernames) AS username
        WHERE named.label IN (username, '@' || username)
           OR EXISTS (
             SELECT 1 FROM unnest(named.display_names) AS display_name
             WHERE named.label IN (display_name || ' (' || username || ')',
                                   display_name || ' (@' || username || ')')
           )
      )
      OR (
        named.label = ANY(named.display_names)
        AND NOT EXISTS (
          SELECT 1 FROM conversation_participants AS other
          WHERE other.conversation_id = named.origin_conversation_id
            AND other.id <> named.author_participant_id
            AND lower(btrim(regexp_replace(normalize(other.display_name_snapshot, NFKC), '\s+', ' ', 'g')))
                = ANY(named.display_names)
        )
      )
    )
), rebound AS (
  UPDATE memory_items_all AS item
     SET subject_participant_id = CASE WHEN candidate.scope = 'group' THEN candidate.author_participant_id END,
         subject_conversation_id = CASE WHEN candidate.scope = 'group' THEN item.origin_conversation_id END,
         subject_user_id = CASE WHEN candidate.scope = 'group' THEN NULL ELSE candidate.author_user_id END,
         subject_label = NULL,
         profile_eligible = (item.provenance_state = 'evidenced' AND item.sensitivity = 'normal')
    FROM candidate
   WHERE item.id = candidate.id
  RETURNING item.id
), audited AS (
  INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
  SELECT candidate.family_id, 'memory.subject_label_rebound', candidate.id,
         jsonb_build_object(
           'previousLabel', candidate.subject_label,
           'authorParticipantId', candidate.author_participant_id,
           'authorUserId', candidate.author_user_id,
           'migration', '134_memory_author_label_rebinding'
         )
  FROM candidate JOIN rebound ON rebound.id = candidate.id
)
INSERT INTO memory_embedding_jobs (memory_item_id)
SELECT id FROM rebound
ON CONFLICT (memory_item_id) DO UPDATE
SET status = 'pending', attempts = 0, lease_token = NULL, lease_expires_at = NULL,
    last_error_code = NULL, updated_at = now();
