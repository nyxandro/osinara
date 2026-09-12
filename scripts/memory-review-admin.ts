/** Root-only operator recovery inside the trusted backend container; never executes a model. */
import { AppError } from "../agent/lib/app-error.js";
import { closeDatabase } from "../agent/lib/database.js";
import { inspectMemoryReviewLanes, skipUnboundMemoryReviewBatch } from "../agent/lib/memory-review/memory-review-admin.js";
import { recoverEmptyReviewModelFailure } from "../agent/lib/memory-review/memory-review-model-admin.js";
import { isConfiguredEveSessionTerminal } from "../agent/lib/sessions/workflow-postgres-session-storage.js";
import { modelRouteKey } from "../agent/lib/model-route.js";

try {
  if (process.getuid?.() !== 0) throw new AppError(
    "AGENT_MEMORY_REVIEW_ADMIN_ROOT_REQUIRED", "Команда доступна только администратору сервера",
  );
  const [action, batchId, reason, ...extra] = process.argv.slice(2);
  if (action === "inspect" && batchId === undefined) {
    console.log(JSON.stringify(await inspectMemoryReviewLanes()));
  } else if (action === "skip-unbound" && batchId && reason && extra.length === 0) {
    const result = await skipUnboundMemoryReviewBatch({ batchId, reason });
    console.log(JSON.stringify({ code: "AGENT_MEMORY_REVIEW_OPERATOR_SKIPPED", batchId, ...result,
      message: "Согласованный пропуск зафиксирован. Проверьте следующую голову очереди командой inspect" }));
  } else if (action === "recover-model" && batchId && reason && extra.length === 2) {
    const { modelProviderConfig } = await import("../agent/lib/model-provider-config.js");
    const outcome = await recoverEmptyReviewModelFailure({ batchId, expectedEveSessionId: reason,
      causeCode: extra[0]!, reason: extra[1]!,
      modelRouteKey: modelRouteKey(modelProviderConfig.agent.transport, modelProviderConfig.agent.models.primary.id),
    }, { isEveSessionTerminal: isConfiguredEveSessionTerminal });
    console.log(JSON.stringify({ code: "AGENT_MEMORY_REVIEW_RECOVERY_WAITING", batchId, outcome,
      message: "Пакет ожидает нового успешного обращения к модели. Повтор запустит штатный диспетчер" }));
  } else {
    throw new AppError("AGENT_MEMORY_REVIEW_ADMIN_USAGE", "Используйте inspect, skip-unbound ID ПРИЧИНА или recover-model ID EVE_SESSION_ID КОД_СБОЯ ПРИЧИНА");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
