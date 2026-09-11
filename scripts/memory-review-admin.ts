/** Root-only operator recovery inside the trusted backend container; never executes a model. */
import { AppError } from "../agent/lib/app-error.js";
import { closeDatabase } from "../agent/lib/database.js";
import { inspectMemoryReviewLanes, skipUnboundMemoryReviewBatch } from "../agent/lib/memory-review/memory-review-admin.js";

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
  } else {
    throw new AppError("AGENT_MEMORY_REVIEW_ADMIN_USAGE", "Используйте inspect либо skip-unbound ID_ПАКЕТА ПРИЧИНА");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
