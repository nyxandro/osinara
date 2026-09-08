/** Run only inside the trusted backend container. Does not print messages or credentials. */
import { database, closeDatabase } from "../agent/lib/database.js";
import { requestTelegramIngressRecovery } from "../agent/lib/telegram-ingress-recovery-admin.js";

try {
  if (process.getuid?.() !== 0) throw new Error("AGENT_TELEGRAM_RECOVERY_ROOT_REQUIRED: Команда доступна только администратору сервера");
  const [action, updateId, reason, ...extra] = process.argv.slice(2);
  if (action === "inspect" && updateId === undefined) {
    const result = await database().query(`SELECT item.update_id::text, item.queue_id,
      item.dispatch_session_id, item.dispatch_turn_id, item.recovery_attempts,
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
  } else {
    throw new Error("AGENT_TELEGRAM_RECOVERY_USAGE: Используйте inspect либо observe|cancel UPDATE_ID ПРИЧИНА");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "AGENT_TELEGRAM_RECOVERY_FAILED: Не удалось запросить восстановление");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
