/** A completed execution or Telegram receipt is not an independent verification of a task. */
import { localScheduledTime } from "../scheduling/local-time.js";
import type { AgentScheduleRecord, AgentScheduleRow } from "./agent-schedule-record.js";
import { rowToAgentSchedule } from "./agent-schedule-record.js";

interface StoredRunObservation {
  id: string;
  executionStatus: string;
  scheduledFor: string;
  completedAt: string | null;
  deliveredAt: string | null;
  errorCode: string | null;
  diagnostics: Array<{ code: string; causeCode: string | null; phase: string | null }>;
}

export type ScheduleListRow = AgentScheduleRow & { last_run: StoredRunObservation | null };
export type ScheduleListItem = AgentScheduleRecord & {
  nextRunAtLocal: string;
  lastRun: (StoredRunObservation & { scheduledForLocal: string; taskOutcome: "not_verified" }) | null;
};

// The parent SELECT authorizes `schedule` in the same statement; no second read can widen its scope.
// Memory failure keys are unique and tied to the exact Eve turn, avoiding scans of incident context.
export const LAST_RUN_PROJECTION = `(SELECT jsonb_build_object(
  'id', run.id, 'executionStatus', run.status, 'scheduledFor', run.scheduled_for,
  'completedAt', run.completed_at, 'errorCode', run.error_code,
  'deliveredAt', (SELECT max(delivered_at) FROM proactive_deliveries
    WHERE source_kind='agent_schedule' AND source_id=run.id),
  'diagnostics', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'code', incident.code, 'causeCode', incident.context->>'causeCode', 'phase', incident.context->>'phase'))
    FROM operational_incidents incident
    WHERE incident.operation_key='memory-context:' || run.eve_session_id || ':' || run.eve_turn_id
      AND incident.context->>'runId'=run.id::text AND incident.code='AGENT_MEMORY_UNAVAILABLE'), '[]'::jsonb)
  ) FROM agent_schedule_runs run WHERE run.schedule_id=schedule.id
    ORDER BY run.scheduled_for DESC, run.created_at DESC LIMIT 1) AS last_run`;

export function rowToScheduleListItem(row: ScheduleListRow): ScheduleListItem {
  return {
    ...rowToAgentSchedule(row),
    nextRunAtLocal: localScheduledTime(row.next_run_at.toISOString(), row.timezone),
    lastRun: row.last_run === null ? null : {
      ...row.last_run,
      scheduledForLocal: localScheduledTime(row.last_run.scheduledFor, row.timezone),
      taskOutcome: "not_verified",
    },
  };
}
