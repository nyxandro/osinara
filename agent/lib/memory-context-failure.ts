/** Failure provenance for the read-only memory pipeline, without retaining private input. */
import { recordBoundedOperationalIncident } from "./operational-incidents/owner-alerts.js";
import { MEMORY_INCIDENT_QUERY_TIMEOUT_MS, MEMORY_INCIDENT_STATEMENT_TIMEOUT_MS } from "./memory-config.js";

export type MemoryContextPhase = "authorization" | "query" | "retrieval" | "embedding" | "search" | "threads" | "profile" | "journal" | "format";

export class MemoryContextFailure extends Error {
  constructor(readonly phase: MemoryContextPhase, cause: unknown) {
    super("AGENT_MEMORY_CONTEXT_FAILED: Не удалось подготовить данные памяти", { cause });
    this.name = "MemoryContextFailure";
  }
}

export function memoryFailureCode(error: unknown): string | null {
  if (error instanceof MemoryContextFailure) return memoryFailureCode(error.cause);
  if (typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^(?:AGENT_[A-Z0-9_]+|[A-Z0-9]{5})$/u.test(error.code)) return error.code;
  // Some existing profile validators use Error with a stable prefix rather than AppError.
  return error instanceof Error ? /^AGENT_[A-Z0-9_]+(?=:)/u.exec(error.message)?.[0] ?? null : null;
}

export interface MemoryContextIncident {
  causeCode: string | null;
  phase: MemoryContextPhase;
  runId: string | null;
  scheduleId: string | null;
  sessionId: string;
  turnId: string;
}

export async function recordMemoryContextIncident(incident: MemoryContextIncident): Promise<void> {
  await recordBoundedOperationalIncident({
    key: `memory-context:${incident.sessionId}:${incident.turnId}`,
    code: "AGENT_MEMORY_UNAVAILABLE",
    summary: "При подготовке ответа не удалось прочитать память. Независимые части задачи могут продолжиться; проверьте диагностику запуска.",
    context: { ...incident },
  }, { statementTimeoutMs: MEMORY_INCIDENT_STATEMENT_TIMEOUT_MS, queryTimeoutMs: MEMORY_INCIDENT_QUERY_TIMEOUT_MS });
}
