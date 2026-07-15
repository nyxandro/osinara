/**
 * Agent schedule domain records and stable operation hashing.
 *
 * Exports:
 * - Schedule recurrence, row, and user-facing record types.
 * - `rowToAgentSchedule`: converts PostgreSQL rows to tool-safe records.
 * - `agentScheduleOperationHash`: replay protection digest for mutation tools.
 */
import { createHash } from "node:crypto";

export type AgentScheduleScope = "family" | "personal";
export type AgentScheduleStatus = "active" | "completed" | "failed" | "leased" | "paused";
export type AgentScheduleRecurrenceKind = "daily" | "once" | "weekly";

export type AgentScheduleRecurrence =
  | { kind: "once" }
  | { interval: number; kind: "daily" }
  | { daysOfWeek: number[]; interval: number; kind: "weekly" };

export interface AgentScheduleRow {
  created_at: Date;
  id: string;
  last_error_code: string | null;
  message_thread_id: string | null;
  next_run_at: Date;
  recurrence_days_of_week: number[] | null;
  recurrence_interval: number;
  recurrence_kind: AgentScheduleRecurrenceKind;
  scenario_prompt: string;
  scope: AgentScheduleScope;
  status: AgentScheduleStatus;
  timezone: string;
  title: string;
  updated_at: Date;
  user_request: string;
}

export interface AgentScheduleRecord {
  createdAt: string;
  id: string;
  lastErrorCode: string | null;
  messageThreadId: string | null;
  nextRunAt: string;
  recurrence: AgentScheduleRecurrence;
  scenarioPrompt: string;
  scope: AgentScheduleScope;
  status: AgentScheduleStatus;
  timezone: string;
  title: string;
  updatedAt: string;
  userRequest: string;
}

function rowRecurrence(row: AgentScheduleRow): AgentScheduleRecurrence {
  if (row.recurrence_kind === "once") return { kind: "once" };
  if (row.recurrence_kind === "daily") {
    return { interval: row.recurrence_interval, kind: "daily" };
  }
  return {
    daysOfWeek: [...(row.recurrence_days_of_week ?? [])],
    interval: row.recurrence_interval,
    kind: "weekly",
  };
}

export function rowToAgentSchedule(row: AgentScheduleRow): AgentScheduleRecord {
  return {
    createdAt: row.created_at.toISOString(),
    id: row.id,
    lastErrorCode: row.last_error_code,
    messageThreadId: row.message_thread_id,
    nextRunAt: row.next_run_at.toISOString(),
    recurrence: rowRecurrence(row),
    scenarioPrompt: row.scenario_prompt,
    scope: row.scope,
    status: row.status,
    timezone: row.timezone,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
    userRequest: row.user_request,
  };
}

export function agentScheduleOperationHash(input: unknown): string {
  // Stable JSON is enough here because tool inputs are parsed objects with deterministic key order.
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
