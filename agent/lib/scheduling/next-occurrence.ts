/**
 * Shared PostgreSQL recurrence arithmetic for reminders and agent schedules.
 * Computes the next occurrence directly from the anchor, without replaying missed periods.
 * Agent weekly schedules with selected weekdays retain their dedicated calendar calculation.
 */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";

export interface NextOccurrence {
  next_index: number;
  next_run_at: Date;
}

// These identifiers are application-owned, never supplied by the model.
const SOURCES = {
  reminders: { table: "reminders", unit: "recurrence_unit" },
  agent_schedules: { table: "agent_schedules", unit: "recurrence_kind" },
} as const;

export async function nextAnchoredOccurrence(
  client: PoolClient,
  source: keyof typeof SOURCES,
  id: string,
  after: Date,
): Promise<NextOccurrence> {
  const { table, unit } = SOURCES[source];
  // Calendar estimates select the current period; its anchored date or the next period is future.
  // PostgreSQL clamps month/year additions to month end, always using the original local anchor.
  const result = await client.query<NextOccurrence>(
    `WITH schedule AS (
       SELECT ${unit}::text AS unit, recurrence_interval AS every,
              recurrence_anchor_local AS anchor_local, recurrence_anchor_at AS anchor_at,
              timezone, occurrence_index, $2::timestamptz AT TIME ZONE timezone AS after_local
         FROM ${table} WHERE id = $1
     ), estimate AS (
       SELECT *, CASE unit
         WHEN 'minutely' THEN floor(extract(epoch FROM ($2::timestamptz - anchor_at)) / (60 * every)) + 1
         WHEN 'hourly' THEN floor(extract(epoch FROM ($2::timestamptz - anchor_at)) / (3600 * every)) + 1
         WHEN 'daily' THEN floor((after_local::date - anchor_local::date)::numeric / every)
         WHEN 'weekly' THEN floor((after_local::date - anchor_local::date)::numeric / (7 * every))
         WHEN 'monthly' THEN floor(((extract(year FROM after_local) - extract(year FROM anchor_local)) * 12
                                   + extract(month FROM after_local) - extract(month FROM anchor_local)) / every)
         WHEN 'yearly' THEN floor((extract(year FROM after_local) - extract(year FROM anchor_local)) / every)
       END AS estimated_index
       FROM schedule
     ), candidates AS (
       SELECT estimate.*, candidate.next_index FROM estimate
       CROSS JOIN LATERAL generate_series(
         greatest(occurrence_index + 1, estimated_index)::int,
         greatest(occurrence_index + 1, estimated_index)::int + 1
       ) AS candidate(next_index)
       WHERE estimated_index IS NOT NULL
     ), occurrences AS (
       SELECT next_index, CASE unit
         WHEN 'minutely' THEN anchor_at + make_interval(secs => 60::double precision * every * next_index)
         WHEN 'hourly' THEN anchor_at + make_interval(secs => 3600::double precision * every * next_index)
         WHEN 'daily' THEN (anchor_local + make_interval(days => every * next_index)) AT TIME ZONE timezone
         WHEN 'weekly' THEN (anchor_local + make_interval(days => 7 * every * next_index)) AT TIME ZONE timezone
         WHEN 'monthly' THEN (anchor_local + make_interval(months => every * next_index)) AT TIME ZONE timezone
         WHEN 'yearly' THEN (anchor_local + make_interval(years => every * next_index)) AT TIME ZONE timezone
       END AS next_run_at FROM candidates
     )
     SELECT next_index, next_run_at FROM occurrences
      WHERE next_run_at > $2::timestamptz ORDER BY next_index LIMIT 1`,
    [id, after],
  );
  const next = result.rows[0];
  if (!next) {
    throw new AppError(
      "AGENT_RECURRENCE_NEXT_TIME_INVALID",
      "Не удалось вычислить следующее время повторения. Проверьте параметры расписания",
    );
  }
  return next;
}
