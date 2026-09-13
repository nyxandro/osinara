/** Workflow completion proves termination, not agent success: read the exact turn's durable protocol outcome. */
import { createApplicationDatabasePool } from "../database-client.js";
import { AppError } from "../app-error.js";
import type { QueryResult } from "pg";

export type NativeTurnOutcome = "completed" | "failed" | "cancelled" | "running" | "unknown";
const PAGE_SIZE = 256;
const MAX_PAGES = 40;
const MAX_EVENT_CHARACTERS = 8 * 1024 * 1024;

export async function readConfiguredEveTurnOutcome(runId: string, turnId: string): Promise<NativeTurnOutcome> {
  if (!/^wrun_[A-Z0-9]{26}$/u.test(runId) || !turnId) throw new AppError("AGENT_EVE_SESSION_ID_INVALID", "Не удалось проверить координаты исполнения");
  const connectionString = process.env.WORKFLOW_POSTGRES_URL;
  if (!connectionString) throw new AppError("AGENT_WORKFLOW_DATABASE_CONFIG_MISSING", "Не задано подключение к базе Workflow");
  const pool = createApplicationDatabasePool({ connectionString,max: 1,connectionTimeoutMillis: 5000 });
  try {
    const run = (await pool.query<{ status: string }>("SELECT status::text FROM workflow.workflow_runs WHERE id=$1", [runId])).rows[0];
    if (!run) return "unknown";
    if (!["completed","failed","cancelled"].includes(run.status)) return "running";
    // Eve 0.40's default getReadable stream uses this exact namespace (verified against installed runtime).
    const streamId = `strm_${runId.slice(5)}_user`;
    let after: string | null = null;
    let pending = "";
    let outcome: NativeTurnOutcome = "unknown";
    const decoder = new TextDecoder("utf-8",{ fatal: true });
    for (let page=0;page<MAX_PAGES;page++) {
      const chunks: QueryResult<{ id: string; data: Buffer }> = await pool.query(`SELECT id,data FROM workflow.workflow_stream_chunks
        WHERE run_id=$1 AND stream_id=$2 AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4`, [runId,streamId,after,PAGE_SIZE]);
      for (const chunk of chunks.rows) {
        pending += decoder.decode(chunk.data,{ stream: true });
        if (pending.length>MAX_EVENT_CHARACTERS) throw new AppError("AGENT_EVE_OUTCOME_EVENT_TOO_LARGE", "Событие исполнения превышает допустимый размер проверки");
        let end: number;
        while ((end=pending.indexOf("\n"))>=0) {
          const line = pending.slice(0,end); pending=pending.slice(end+1);
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; data?: { turnId?: string } };
          if (event.type === "session.failed") outcome="failed";
          else if (event.data?.turnId === turnId) {
            if (event.type === "turn.completed") outcome="completed";
            else if (event.type === "turn.failed") outcome="failed";
            else if (event.type === "turn.cancelled") outcome="cancelled";
          }
        }
        after=chunk.id;
      }
      if (chunks.rows.length<PAGE_SIZE) {
        pending += decoder.decode();
        if (pending.trim()) return "unknown";
        return outcome;
      }
    }
    return "unknown";
  } finally { await pool.end(); }
}
