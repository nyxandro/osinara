/** Calendar-preserving next occurrence shared by completion and explicit reactivation. */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { nextAnchoredOccurrence } from "../scheduling/next-occurrence.js";
import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";

interface NextOccurrenceRow {
  next_index: number;
  next_run_at: Date;
}

export async function nextAgentScheduleOccurrence(
  client: PoolClient,
  scheduleId: string,
  recurrenceKind: AgentScheduleRecurrenceKind,
  after: Date,
): Promise<NextOccurrenceRow | null> {
  if (recurrenceKind === "once") return null;
  if (recurrenceKind !== "weekly") return await nextAnchoredOccurrence(client, "agent_schedules", scheduleId, after);
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

/** A finished limited schedule still points at its last occurrence; never dispatch it twice. */
export async function advanceReactivatedSchedule(client: PoolClient, scheduleId: string, kind: AgentScheduleRecurrenceKind): Promise<void> {
  // Run timestamps pass through pg's JavaScript Date parser; compare at that same precision.
  const terminal = await client.query<{ after: Date }>(`SELECT greatest(now(),run.scheduled_for,run.completed_at) AS after
    FROM agent_schedule_runs run JOIN agent_schedules schedule ON schedule.id=run.schedule_id
    WHERE schedule.id=$1 AND run.scheduled_for=date_trunc('milliseconds',schedule.next_run_at) AND run.status <> 'claimed'`, [scheduleId]);
  if (!terminal.rowCount) return;
  if (kind === "once") throw new AppError("AGENT_SCHEDULE_ONCE_ALREADY_EXECUTED",
    "Попытка этого однократного расписания уже завершена. Укажите новое время или выберите «запустить сейчас»");
  const next = await nextAgentScheduleOccurrence(client, scheduleId, kind, terminal.rows[0]!.after);
  if (!next) return;
  await client.query("UPDATE agent_schedules SET next_run_at=$2,occurrence_index=$3 WHERE id=$1", [scheduleId, next.next_run_at, next.next_index]);
}
