/** Run only inside the trusted backend container. Does not print messages or credentials. */
import { database, closeDatabase } from "../agent/lib/database.js";
import { closeExpiredUnboundTelegramIngress, requestTelegramIngressRecovery } from "../agent/lib/telegram-ingress-recovery-admin.js";

try {
  if (process.getuid?.() !== 0) throw new Error("AGENT_TELEGRAM_RECOVERY_ROOT_REQUIRED: Команда доступна только администратору сервера");
  const [action, updateId, reason, ...extra] = process.argv.slice(2);
  if (action === "inspect" && updateId === undefined) {
    const result = await database().query(`SELECT item.update_id::text, item.queue_id,
      item.dispatch_id, item.dispatch_started_at, item.recovery_protocol,
      item.preparation_completed_at, item.dispatch_kind, item.dispatch_session_id, item.dispatch_turn_id, item.recovery_attempts,
      item.recovery_cancel_requested, item.last_error_code,
      (SELECT count(*) FROM telegram_ingress_updates waiting WHERE waiting.queue_id=item.queue_id
        AND waiting.status='pending') AS waiting_messages
      FROM telegram_ingress_updates item WHERE last_error_code='AGENT_TELEGRAM_CANCELLATION_UNCONFIRMED'
      ORDER BY item.updated_at`);
    console.log(JSON.stringify(result.rows));
  } else if ((action === "observe" || action === "cancel") && updateId && reason && extra.length === 0) {
    await requestTelegramIngressRecovery(updateId, action, reason);
    console.log(JSON.stringify({ code: "AGENT_TELEGRAM_RECOVERY_REQUESTED", updateId,
      message: "Проверка запрошена. Очередь откроется только после подтверждения состояния Eve" }));
  } else if (action === "close-unbound" && updateId && reason && extra.length === 1) {
    await closeExpiredUnboundTelegramIngress(updateId, reason, extra[0]!);
    console.log(JSON.stringify({ code: "AGENT_TELEGRAM_INTERRUPTED_CLOSED", updateId,
      message: "Прерванный запрос закрыт без повторного исполнения. Очередь может продолжить работу" }));
  } else {
    throw new Error("AGENT_TELEGRAM_RECOVERY_USAGE: Используйте inspect, observe|cancel UPDATE_ID ПРИЧИНА или close-unbound UPDATE_ID DISPATCH_ID ПРИЧИНА");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "AGENT_TELEGRAM_RECOVERY_FAILED: Не удалось запросить восстановление");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
