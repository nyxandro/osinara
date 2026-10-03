-- Очередь входящих строго последовательна внутри чата: пока идёт ход, следующие сообщения того же
-- чата ждут его конца. В группе большая часть этих сообщений — переписка, которую приложение только
-- записывает в журнал, и после конца хода она разбирается за доли секунды. Возраст самого старого
-- ждущего сообщения считал и её, поэтому 23 сентября критическая тревога 12 минут сообщала о
-- «молчащем ассистенте», хотя ответа ждал один человек — автор долгого запроса, а остальные чаты
-- обслуживались (#272).
--
-- Добавляются две величины, отвечающие на разные вопросы.
--
-- stalled_oldest_age_seconds — сколько ждёт самое старое сообщение в чате, где сейчас ничего не
-- исполняется. Её дают только настоящие остановки: worker не берёт сообщения, аренда умершего
-- обработчика не продлевается, очередь заблокирована, или все места обработки заняты другими чатами.
-- Исполняющимся считается сообщение с живой арендой и начатым ходом: взятое в работу, но ещё
-- ждущее свободного места обработки, ход не начало (dispatch_started_at ставится после места).
-- Исключение принято сознательно: ход, заново взятый после сбоя обработчика, сохраняет своё
-- dispatch_started_at и считается исполняющимся, даже пока ждёт места. Это требует сбоя обработчика
-- при двух занятых местах сразу.
--
-- longest_running_seconds — сколько длится самый долгий ход, идущий сейчас. Это сигнал о тяжёлой
-- задаче или зависшем ходе, а не об остановке приложения.
--
-- Прежняя колонка oldest_pending_age_seconds оставлена без изменений: на неё может опираться
-- панель хаба, а CREATE OR REPLACE VIEW допускает только добавление колонок в конец.
CREATE OR REPLACE VIEW monitoring_telegram_ingress AS
  SELECT
    count(*) FILTER (WHERE status = 'pending')    AS pending,
    count(*) FILTER (WHERE status = 'processing') AS processing,
    count(*) FILTER (WHERE status = 'failed')     AS failed,
    coalesce(
      extract(epoch FROM now() - min(received_at) FILTER (WHERE status = 'pending')),
      0
    ) AS oldest_pending_age_seconds,
    (
      SELECT coalesce(extract(epoch FROM now() - min(waiting.received_at))::bigint, 0)
      FROM telegram_ingress_updates waiting
      WHERE (waiting.status = 'pending'
             OR (waiting.status = 'processing'
                 AND (waiting.lease_expires_at <= now() OR waiting.dispatch_started_at IS NULL)))
        AND NOT EXISTS (
          SELECT 1 FROM telegram_ingress_updates running
          WHERE running.queue_id = waiting.queue_id AND running.status = 'processing'
            AND running.lease_expires_at > now() AND running.dispatch_started_at IS NOT NULL
        )
    ) AS stalled_oldest_age_seconds,
    (
      SELECT coalesce(extract(epoch FROM now() - min(dispatch_started_at))::bigint, 0)
      FROM telegram_ingress_updates
      WHERE status = 'processing' AND lease_expires_at > now() AND dispatch_started_at IS NOT NULL
    ) AS longest_running_seconds
  FROM telegram_ingress_updates;

GRANT SELECT ON monitoring_telegram_ingress TO osinara_metrics;
