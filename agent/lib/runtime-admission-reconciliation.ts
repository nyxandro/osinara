/**
 * The single backend reconciles admissions in its own container that nobody will release: those of
 * processes that are gone, and its own whose work settled while the database could not take the
 * release (#553). Every admission is held by the process doing the work, for as long as the work runs;
 * a holder of another live process is never touched, since only that process knows its work.
 */
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { database } from "./database.js";
import { AppError } from "./app-error.js";

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

/** `isActive` tells whether an admission of this process still runs its work (`isRuntimeAdmissionActive`). */
export async function reconcileRuntimeAdmissions(isActive: (admissionId: string) => boolean): Promise<void> {
  const self = await runtimeProcessIdentity();
  const holders = await database().query<{ id: string; owner_pid: number; owner_start_ticks: string }>(
    `SELECT id,owner_pid,owner_start_ticks FROM runtime_admission_holders
      WHERE agent_session_id IS NULL AND owner_hostname=$1 AND owner_pid IS NOT NULL ORDER BY created_at LIMIT 100`, [hostname()]);
  for (const holder of holders.rows) {
    const ownedHere = holder.owner_pid === self.pid && holder.owner_start_ticks === self.startTicks;
    // Asked only after the rows are read: an admission registers before writing its row, so a row of
    // this process absent from the active set cannot belong to work that is starting.
    if (ownedHere && isActive(holder.id)) continue;
    // PID reuse is not evidence of a live old process; compare the kernel's immutable start time.
    if (!ownedHere && await processStartTicks(holder.owner_pid) === holder.owner_start_ticks) continue;
    const deleted = await database().query(`DELETE FROM runtime_admission_holders WHERE id=$1 AND agent_session_id IS NULL
      AND EXISTS(SELECT 1 FROM runtime_maintenance WHERE singleton AND phase<>'frozen')
      AND owner_hostname=$2 AND owner_pid=$3 AND owner_start_ticks=$4`, [holder.id,hostname(),holder.owner_pid,holder.owner_start_ticks]);
    if (!deleted.rowCount) continue;
    // Literal codes on purpose: tests/monitoring-alert-rules.test.ts finds informational codes by this exact shape.
    if (ownedHere) console.info(JSON.stringify({ code: "AGENT_RUNTIME_SETTLED_ADMISSION_RECONCILED", holderId: holder.id }));
    else console.info(JSON.stringify({ code: "AGENT_RUNTIME_DEAD_PROCESS_RECONCILED", holderId: holder.id }));
  }
}
