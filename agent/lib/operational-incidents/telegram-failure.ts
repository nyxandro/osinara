/** Correlate channel, session and ingress failures without ever using the source chat as recipient. */
import { database } from "../database.js";
import { recordOperationalIncident } from "./owner-alerts.js";

export async function recordTelegramFailure(input: {
  sessionId: string; turnId?: string; updateId?: string; code: string; chatId?: string;
}): Promise<void> {
  let updateId = input.updateId;
  if (updateId === undefined) {
    const result = await database().query<{ update_id: string }>(`SELECT update_id::text FROM telegram_ingress_updates
      WHERE dispatch_session_id=$1 AND ($2::text IS NULL OR dispatch_turn_id=$2)
      ORDER BY update_id DESC LIMIT 1`, [input.sessionId, input.turnId ?? null]);
    updateId = result.rows[0]?.update_id;
  }
  const scheduledRun = updateId === undefined ? (await database().query<{ id: string }>(
    "SELECT id FROM agent_schedule_runs WHERE eve_session_id=$1 ORDER BY created_at DESC LIMIT 1", [input.sessionId])).rows[0] : undefined;
  await recordOperationalIncident({ key: updateId !== undefined ? `telegram:${updateId}` : scheduledRun ? `schedule-run:${scheduledRun.id}` : `eve:${input.sessionId}:${input.turnId ?? "session"}`,
    code: "AGENT_TELEGRAM_EXECUTION_FAILED", summary: "Обработка запроса завершилась с ошибкой. Проверьте результат перед повторным выполнением.",
    context: { eveSessionId: input.sessionId, eveTurnId: input.turnId ?? null, updateId: updateId ?? null,
      chatId: input.chatId ?? null, causeCode: input.code } });
}
