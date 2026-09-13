/** The single backend reconciles only processes in its own container and exact terminal native sessions. */
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { database } from "./database.js";
import { AppError } from "./app-error.js";
import { readConfiguredEveRunStatus } from "./sessions/workflow-postgres-session-storage.js";

const START_TIME_FIELD_AFTER_COMM = 19;
async function processStartTicks(pid: number): Promise<string | null> {
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const value = stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/u)[START_TIME_FIELD_AFTER_COMM];
  if (!value || !/^\d+$/u.test(value)) throw new AppError("AGENT_RUNTIME_PROCESS_IDENTITY_INVALID", "Не удалось проверить процесс фоновой операции");
  return value;
}

export async function runtimeProcessIdentity() {
  const startTicks = await processStartTicks(process.pid);
  if (startTicks === null) throw new AppError("AGENT_RUNTIME_PROCESS_IDENTITY_MISSING", "Не удалось определить текущий процесс приложения");
  return { hostname: hostname(), pid: process.pid, startTicks };
}

export async function reconcileRuntimeAdmissions(readStatus = readConfiguredEveRunStatus): Promise<void> {
  const holders = await database().query<{ id: string; owner_pid: number; owner_start_ticks: string }>(
    `SELECT id,owner_pid,owner_start_ticks FROM runtime_admission_holders
      WHERE eve_session_id IS NULL AND owner_hostname=$1 AND owner_pid IS NOT NULL ORDER BY created_at LIMIT 100`, [hostname()]);
  for (const holder of holders.rows) {
    // PID reuse is not evidence of a live old process; compare the kernel's immutable start time.
    if (await processStartTicks(holder.owner_pid) === holder.owner_start_ticks) continue;
    const deleted = await database().query(`DELETE FROM runtime_admission_holders WHERE id=$1 AND eve_session_id IS NULL
      AND EXISTS(SELECT 1 FROM runtime_maintenance WHERE singleton AND phase<>'frozen')
      AND owner_hostname=$2 AND owner_pid=$3 AND owner_start_ticks=$4`, [holder.id,hostname(),holder.owner_pid,holder.owner_start_ticks]);
    if (deleted.rowCount) console.info(JSON.stringify({ code: "AGENT_RUNTIME_DEAD_PROCESS_RECONCILED", holderId: holder.id }));
  }
  const sessions = await database().query<{ eve_session_id: string }>(`SELECT DISTINCT eve_session_id FROM runtime_admission_holders
    WHERE eve_session_id IS NOT NULL ORDER BY eve_session_id LIMIT 100`);
  for (const row of sessions.rows) {
    const status = await readStatus(row.eve_session_id);
    if (status !== "completed" && status !== "failed" && status !== "cancelled") continue;
    await database().query("DELETE FROM runtime_admission_holders WHERE eve_session_id=$1 AND EXISTS(SELECT 1 FROM runtime_maintenance WHERE singleton AND phase<>'frozen')", [row.eve_session_id]);
  }
}
