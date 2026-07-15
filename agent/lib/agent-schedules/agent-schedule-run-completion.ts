/**
 * SQL-backed completion helpers for scheduled agent runs.
 *
 * Exports:
 * - `finishActiveAgentScheduleRun`: marks a running Eve handoff completed or failed and advances recurrence.
 */
import type { PoolClient } from "pg";

import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";

interface ActiveRunRow {
  family_id: string;
  recurrence_kind: AgentScheduleRecurrenceKind;
  run_id: string;
  schedule_id: string;
}

interface NextOccurrenceRow {
  next_index: number;
  next_run_at: Date;
}

async function nextDailyOccurrence(
  client: PoolClient,
  scheduleId: string,
  after: Date,
): Promise<NextOccurrenceRow | null> {
  const result = await client.query<NextOccurrenceRow>(
    `WITH RECURSIVE occurrences AS (
       SELECT schedule.occurrence_index + 1 AS next_index,
              CASE schedule.recurrence_kind
                WHEN 'daily' THEN (schedule.recurrence_anchor_local + make_interval(days => schedule.recurrence_interval * (schedule.occurrence_index + 1))) AT TIME ZONE schedule.timezone
                ELSE schedule.next_run_at
              END AS next_run_at,
              schedule.occurrence_index AS initial_index
         FROM agent_schedules AS schedule WHERE schedule.id = $1
       UNION ALL
       SELECT occurrence.next_index + 1,
              (schedule.recurrence_anchor_local + make_interval(days => schedule.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE schedule.timezone,
              occurrence.initial_index
         FROM occurrences AS occurrence
         JOIN agent_schedules AS schedule ON schedule.id = $1
        WHERE occurrence.next_run_at <= $2
          AND occurrence.next_index - occurrence.initial_index < 100000
     )
     SELECT next_index, next_run_at
       FROM occurrences WHERE next_run_at > $2
      ORDER BY next_index LIMIT 1`,
    [scheduleId, after],
  );
  return result.rows[0] ?? null;
}

async function nextWeeklyOccurrence(
  client: PoolClient,
  scheduleId: string,
  after: Date,
): Promise<NextOccurrenceRow | null> {
  const result = await client.query<NextOccurrenceRow>(
    `WITH schedule AS (
       SELECT id, timezone, recurrence_interval, recurrence_days_of_week,
              recurrence_anchor_local, occurrence_index
         FROM agent_schedules WHERE id = $1
     ), candidates AS (
       SELECT schedule.occurrence_index + row_number() OVER (ORDER BY candidate.local_time) AS next_index,
              candidate.local_time AT TIME ZONE schedule.timezone AS next_run_at
         FROM schedule
         CROSS JOIN LATERAL (
           SELECT (($2 AT TIME ZONE schedule.timezone)::date + days.day_offset + schedule.recurrence_anchor_local::time) AS local_time
             FROM generate_series(0, schedule.recurrence_interval * 7 + 7) AS days(day_offset)
         ) AS candidate
        WHERE extract(isodow FROM candidate.local_time)::int = ANY(schedule.recurrence_days_of_week)
          AND mod(
            floor(extract(epoch FROM (date_trunc('week', candidate.local_time) - date_trunc('week', schedule.recurrence_anchor_local))) / 604800)::int,
            schedule.recurrence_interval
          ) = 0
          AND candidate.local_time AT TIME ZONE schedule.timezone > $2
     )
     SELECT next_index, next_run_at FROM candidates ORDER BY next_run_at LIMIT 1`,
    [scheduleId, after],
  );
  return result.rows[0] ?? null;
}

async function nextOccurrence(
  client: PoolClient,
  scheduleId: string,
  recurrenceKind: AgentScheduleRecurrenceKind,
  after: Date,
): Promise<NextOccurrenceRow | null> {
  if (recurrenceKind === "daily") return await nextDailyOccurrence(client, scheduleId, after);
  if (recurrenceKind === "weekly") return await nextWeeklyOccurrence(client, scheduleId, after);
  return null;
}

export async function finishActiveAgentScheduleRun(
  client: PoolClient,
  input: { applicationSessionId: string; completedAt: Date; errorCode: string | null; eveSessionId: string },
): Promise<boolean> {
  const active = await client.query<ActiveRunRow>(
    `SELECT run.id AS run_id, schedule.id AS schedule_id, schedule.family_id,
            schedule.recurrence_kind
       FROM agent_schedule_runs AS run
       JOIN agent_schedules AS schedule ON schedule.id = run.schedule_id
      WHERE run.application_session_id = $1
        AND run.eve_session_id = $2
        AND run.status = 'running'
        AND schedule.status = 'leased'
      FOR UPDATE OF run, schedule`,
    [input.applicationSessionId, input.eveSessionId],
  );
  const row = active.rows[0];
  if (!row) return false;

  // The run row is terminal before the schedule is re-opened, avoiding overlap windows.
  await client.query(
    `UPDATE agent_schedule_runs
        SET status = $2, completed_at = $3, error_code = $4, updated_at = $3
      WHERE id = $1`,
    [row.run_id, input.errorCode === null ? "completed" : "failed", input.completedAt, input.errorCode],
  );

  const next = await nextOccurrence(client, row.schedule_id, row.recurrence_kind, input.completedAt);
  if (!next) {
    await client.query(
      `UPDATE agent_schedules
          SET status = $2, lease_token = NULL, lease_expires_at = NULL,
              dispatch_started_at = NULL, last_error_code = $3, updated_at = $4
        WHERE id = $1`,
      [
        row.schedule_id,
        input.errorCode === null ? "completed" : "failed",
        input.errorCode,
        input.completedAt,
      ],
    );
    return true;
  }

  await client.query(
    `UPDATE agent_schedules
        SET status = 'active', occurrence_index = $2, next_run_at = $3,
            attempts = 0, lease_token = NULL, lease_expires_at = NULL,
            dispatch_started_at = NULL, last_error_code = $4, updated_at = $5
      WHERE id = $1`,
    [row.schedule_id, next.next_index, next.next_run_at, input.errorCode, input.completedAt],
  );
  return true;
}
