/** Durable admission holds survive connection loss until the owning work actually settles. */
import { AppError } from "./app-error.js";
import { database } from "./database.js";

export async function withRuntimeAdmission<T>(
  kind: "ordinary" | "callback",
  work: (admissionId: string) => Promise<T>,
): Promise<T | null> {
  const id = crypto.randomUUID();
  const state = await database().query<{ phase: string; id: string | null }>(
    `WITH config AS MATERIALIZED (
       SELECT phase FROM runtime_maintenance WHERE singleton FOR SHARE
     ), admitted AS (
       INSERT INTO runtime_admission_holders(id,kind)
       SELECT $1,$2 FROM config WHERE phase='ready' OR (phase='draining' AND $2='callback')
       RETURNING id
     ) SELECT config.phase, (SELECT id FROM admitted) AS id FROM config`,
    [id, kind],
  );
  const phase = state.rows[0]?.phase;
  if (!phase || !["ready", "draining", "frozen"].includes(phase)) {
    throw new AppError("AGENT_RUNTIME_MAINTENANCE_MISSING", "Не удалось проверить готовность обработки запросов");
  }
  if (phase === "frozen" || phase === "draining" && kind === "ordinary") return null;
  if (state.rows[0]?.id !== id) throw new AppError("AGENT_RUNTIME_ADMISSION_MISSING", "Не удалось зарегистрировать выполняемую операцию");
  let workError: unknown;
  try {
    return await work(id);
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    try {
      await database().query("DELETE FROM runtime_admission_holders WHERE id=$1", [id]);
    } catch (cleanupError) {
      throw new AggregateError(workError === undefined ? [cleanupError] : [workError, cleanupError],
        "AGENT_RUNTIME_ADMISSION_RELEASE_FAILED: Не удалось подтвердить завершение фоновой операции; обновление приостановлено");
    }
  }
}
