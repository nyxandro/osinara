/**
 * Occurrences of a disconnected group's schedules pass without running (#465).
 *
 * Export:
 * - `passDisconnectedGroupSchedules`: closes every due occurrence of a disconnected group's schedule
 *   or monitor, before anything is claimed.
 *
 * The owner's rule: while the group is disconnected its processes do not run, and nothing of them comes
 * later. A one-off schedule ends; a repeating one moves to its next time after now through the same
 * calendar arithmetic its completion uses. No run is created, so nothing counts as a run, fails or
 * notifies anyone.
 */
import type { PoolClient } from "pg";

import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";
import { nextAgentScheduleOccurrence } from "./agent-schedule-next-occurrence.js";

export async function passDisconnectedGroupSchedules(client: PoolClient, now: Date): Promise<number> {
  const due = await client.query<{
    check_until: Date | null; family_id: string; id: string; recurrence_kind: AgentScheduleRecurrenceKind;
  }>(
    `SELECT schedule.id, schedule.family_id, schedule.recurrence_kind, schedule.check_until
       FROM agent_schedules AS schedule
       JOIN telegram_groups AS group_row ON group_row.id = schedule.group_id
      WHERE schedule.status = 'active' AND schedule.next_run_at <= $1
        AND group_row.disconnected_at IS NOT NULL
      ORDER BY schedule.next_run_at, schedule.id
      FOR UPDATE OF schedule SKIP LOCKED`,
    [now],
  );
  for (const schedule of due.rows) {
    const next = await nextAgentScheduleOccurrence(client, schedule.id, schedule.recurrence_kind, now);
    // A monitor's watch never runs past its end: a next tick after it means the watch is over.
    if (next === null || (schedule.check_until !== null && next.next_run_at > schedule.check_until)) {
      await client.query(
        "UPDATE agent_schedules SET status = 'completed', attempts = 0, last_error_code = NULL, updated_at = $2 WHERE id = $1",
        [schedule.id, now],
      );
    } else {
      await client.query(
        `UPDATE agent_schedules
            SET next_run_at = $2, occurrence_index = $3, attempts = 0, last_error_code = NULL, updated_at = $4
          WHERE id = $1`,
        [schedule.id, next.next_run_at, next.next_index, now],
      );
    }
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       VALUES ($1, 'agent_schedule.skipped_group_disconnected', $2, '{}'::jsonb)`,
      [schedule.family_id, schedule.id],
    );
  }
  return due.rows.length;
}
