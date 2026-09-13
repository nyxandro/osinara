/** Durable admission holds survive connection loss until the owning work actually settles. */
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import { recoverDatabaseBookkeeping } from "./database-recovery.js";
import { runtimeProcessIdentity } from "./runtime-admission-reconciliation.js";

const backendInstanceId = crypto.randomUUID();

export async function withRuntimeAdmission<T>(
  kind: "ordinary" | "callback",
  work: (admissionId: string) => Promise<T>,
): Promise<T | null> {
  const id = crypto.randomUUID();
  const owner = await runtimeProcessIdentity();
  const state = await recoverDatabaseBookkeeping(() => database().query<{ phase: string; id: string | null }>(
    `WITH config AS MATERIALIZED (
       SELECT phase FROM runtime_maintenance WHERE singleton FOR SHARE
     ), admitted AS (
        INSERT INTO runtime_admission_holders(id,kind,owner_instance_id,owner_hostname,owner_pid,owner_start_ticks)
        SELECT $1,$2,$3,$4,$5,$6 FROM config WHERE phase='ready' OR (phase='draining' AND $2='callback')
        ON CONFLICT(id) DO UPDATE SET id=excluded.id
       RETURNING id
     ) SELECT config.phase, (SELECT id FROM admitted) AS id FROM config`,
    [id, kind, backendInstanceId,owner.hostname,owner.pid,owner.startTicks],
  ));
  const phase = state.rows[0]?.phase;
  if (!phase || !["ready", "draining", "frozen"].includes(phase)) {
    throw new AppError("AGENT_RUNTIME_MAINTENANCE_MISSING", "Не удалось проверить готовность обработки запросов");
  }
  if (phase === "frozen" || phase === "draining" && kind === "ordinary") {
    // A previous INSERT may have committed before its acknowledgement was lost and phase changed.
    await recoverDatabaseBookkeeping(() => database().query("DELETE FROM runtime_admission_holders WHERE id=$1 AND owner_instance_id=$2", [id,backendInstanceId]));
    return null;
  }
  if (state.rows[0]?.id !== id) throw new AppError("AGENT_RUNTIME_ADMISSION_MISSING", "Не удалось зарегистрировать выполняемую операцию");
  let workError: unknown;
  try {
    return await work(id);
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    try {
      await recoverDatabaseBookkeeping(() => database().query("DELETE FROM runtime_admission_holders WHERE id=$1", [id]));
    } catch (cleanupError) {
      throw new AggregateError(workError === undefined ? [cleanupError] : [workError, cleanupError],
        "AGENT_RUNTIME_ADMISSION_RELEASE_FAILED: Не удалось подтвердить завершение фоновой операции; обновление приостановлено");
    }
  }
}
