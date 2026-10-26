-- Встроенного вопроса ask_question больше нет. Вопрос, который ждал ответа в момент обновления, иначе
-- остался бы без пути закрытия, и разговор с ним застрял бы навсегда. Он становится подтверждением с
-- вариантами «Approve» и «Cancel»: штатный тайм-аут подтверждений отменит его, и ход продолжится, а
-- модель прочитает отказ от инструмента. Ходы, которые уже завершились, не трогаются.
WITH waiting AS (
  SELECT id FROM agent_turns WHERE status = 'waiting_input'
)
UPDATE agent_tool_calls AS call
   SET input_request = jsonb_set(
         jsonb_set(call.input_request::jsonb, '{kind}', '"tool-approval"'),
         '{options}', '[{"id":"approve","label":"Approve"},{"id":"cancel","label":"Cancel"}]'
       )::json,
       updated_at = now()
 WHERE call.state = 'awaiting_input'
   AND call.input_request->>'kind' = 'question'
   AND call.turn_id IN (SELECT id FROM waiting);

-- Родитель ждёт вопрос своего подагента через копию его запросов: копия меняется так же.
WITH waiting AS (
  SELECT id FROM agent_turns WHERE status = 'waiting_input'
)
UPDATE agent_tool_calls AS call
   SET input_request = jsonb_set(
         call.input_request::jsonb,
         '{requests}',
         (SELECT jsonb_agg(CASE WHEN request->>'kind' = 'question'
                   THEN jsonb_set(jsonb_set(request, '{kind}', '"tool-approval"'),
                     '{options}', '[{"id":"approve","label":"Approve"},{"id":"cancel","label":"Cancel"}]')
                   ELSE request END ORDER BY position)
            FROM jsonb_array_elements(call.input_request::jsonb -> 'requests') WITH ORDINALITY AS item(request, position))
       )::json,
       updated_at = now()
 WHERE call.state = 'awaiting_input'
   AND call.input_request->>'kind' = 'subagent'
   AND call.input_request::jsonb @? '$.requests[*] ? (@.kind == "question")'
   AND call.turn_id IN (SELECT id FROM waiting);

UPDATE telegram_hitl_approvals
   SET request_kind = 'tool-approval'
 WHERE request_kind = 'question' AND consumed_at IS NULL;
