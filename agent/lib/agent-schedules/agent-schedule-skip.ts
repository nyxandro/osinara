/**
 * Skipping the rest of today's runs of a scenario, by a press of its "read" button (#480).
 *
 * Exports:
 * - `AgentScheduleSkipTarget`: the chat and the person a button speaks for.
 * - `AgentScheduleSkipOutcome`: what a press did, for its pop-up and the line under the message.
 * - `skipAgentScheduleForDay`: marks the scenario skipped until the next midnight of its timezone.
 * - `findAgentScheduleSkipTargets`: which of the named scenarios a button in this chat may skip.
 * - `passSkippedAgentSchedules`: closes due occurrences of skipped scenarios before anything is claimed.
 *
 * Key constructs:
 * - The owner's rule (F1 of #480): a press counts the scenario as read for the day of the press;
 *   occurrences up to the next midnight in the scenario's timezone pass without running, later ones
 *   run as scheduled. No run is created, so a skipped occurrence counts as nothing and notifies nobody.
 * - A button only ever names a scenario of its own chat that its addressee may change: a personal
 *   one of that person, or a family group's one whose author is that person or that the family's
 *   owner presses, the same rule as any change of a family scenario. An external group's scenario is
 *   never a target, because buttons with an addressee go out only in private chats and family groups.
 * - A card of an earlier day does not skip today: the person has not seen today's tasks.
 * - The skip only ever moves forward: an old card pressed again never brings back runs a newer press
 *   skipped.
 * - Each counted press is recorded once in the audit journal under its own id (the button set's
 *   token). A replay of that press — the queue step after the arrival, an edit that never landed —
 *   finds it there and changes nothing: it neither swallows a run the person asked for since ("run it
 *   now" and a new time clear the skip) nor turns into «не засчитано» after the scenario ended.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import type { AgentScheduleRecurrenceKind } from "./agent-schedule-record.js";
import { nextAgentScheduleOccurrence } from "./agent-schedule-next-occurrence.js";

export interface AgentScheduleSkipTarget {
  addresseeTelegramUserId: string;
  telegramChatId: string;
}

export type AgentScheduleSkipOutcome =
  | { kind: "missing" }
  | { kind: "skipped"; localTime: string; title: string }
  | { kind: "stale" };

const SKIP_EVENT = "agent_schedule.skipped_for_day";

// A scenario that is not running anymore cannot be read for the day.
const SKIPPABLE_STATUSES = ["active", "leased", "paused"];

// The chat and the person; the scenario's state is checked separately, so a press already applied
// is recognised after the scenario ended.
const OWN_SCENARIO = `schedule.telegram_chat_id = $2
  AND schedule.scope::text <> 'group'
  AND CASE schedule.scope::text
    WHEN 'personal' THEN owner.telegram_user_id = $3
    ELSE EXISTS (
      SELECT 1 FROM users AS presser
        JOIN family_memberships AS membership ON membership.user_id = presser.id
       WHERE presser.telegram_user_id = $3 AND membership.family_id = schedule.family_id
         AND (presser.id = schedule.author_user_id OR membership.role = 'owner')
    )
  END`;
const TARGET_CONDITION = `${OWN_SCENARIO} AND schedule.status::text = ANY($4::text[])`;

export async function findAgentScheduleSkipTargets(
  input: AgentScheduleSkipTarget & { scheduleIds: readonly string[] },
): Promise<Set<string>> {
  if (input.scheduleIds.length === 0) return new Set();
  const result = await database().query<{ id: string }>(
    `SELECT schedule.id
       FROM agent_schedules AS schedule
       LEFT JOIN users AS owner ON owner.id = schedule.owner_user_id
      WHERE schedule.id = ANY($1::uuid[]) AND ${TARGET_CONDITION}`,
    [input.scheduleIds, input.telegramChatId, input.addresseeTelegramUserId, SKIPPABLE_STATUSES],
  );
  return new Set(result.rows.map((row) => row.id));
}

export async function skipAgentScheduleForDay(input: AgentScheduleSkipTarget & {
  pressedAt: Date;
  /** The press's own id: the token of its button set, which takes one press. */
  pressId: string;
  scheduleId: string;
  /** When the message with the button went out; its local day must be the day of the press. */
  sentAt: Date;
}): Promise<AgentScheduleSkipOutcome> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      family_id: string; local_time: string; same_day: boolean; skippable: boolean; title: string; until: Date;
    }>(
      `SELECT schedule.family_id, schedule.title,
              schedule.status::text = ANY($4::text[]) AS skippable,
              ($5::timestamptz AT TIME ZONE schedule.timezone)::date
                = ($6::timestamptz AT TIME ZONE schedule.timezone)::date AS same_day,
              ((($6::timestamptz AT TIME ZONE schedule.timezone)::date + 1)::timestamp
                AT TIME ZONE schedule.timezone) AS until,
              to_char($6::timestamptz AT TIME ZONE schedule.timezone, 'FMHH24:MI') AS local_time
         FROM agent_schedules AS schedule
         LEFT JOIN users AS owner ON owner.id = schedule.owner_user_id
        WHERE schedule.id = $1 AND ${OWN_SCENARIO}
        FOR UPDATE OF schedule`,
      [input.scheduleId, input.telegramChatId, input.addresseeTelegramUserId, SKIPPABLE_STATUSES,
        input.sentAt, input.pressedAt],
    );
    const schedule = found.rows[0];
    if (schedule !== undefined) {
      // This very press was counted before; the schedule row lock above orders the check and the record.
      const counted = await client.query(
        `SELECT 1 FROM audit_events
          WHERE family_id = $1 AND event_type = $2 AND subject_id = $3 AND metadata->>'pressId' = $4
          LIMIT 1`,
        [schedule.family_id, SKIP_EVENT, input.scheduleId, input.pressId],
      );
      if ((counted.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        return { kind: "skipped", localTime: schedule.local_time, title: schedule.title };
      }
    }
    if (schedule === undefined || !schedule.skippable) {
      await client.query("ROLLBACK");
      return { kind: "missing" };
    }
    if (!schedule.same_day) {
      await client.query("ROLLBACK");
      return { kind: "stale" };
    }
    // Only forward: a newer press that skips further stays.
    await client.query(
      `UPDATE agent_schedules SET skipped_until = $2, skipped_at = $3, updated_at = now()
        WHERE id = $1 AND (skipped_until IS NULL OR skipped_until < $2)`,
      [input.scheduleId, schedule.until, input.pressedAt],
    );
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       VALUES ($1, $2, $3, jsonb_build_object('pressId', $4::text))`,
      [schedule.family_id, SKIP_EVENT, input.scheduleId, input.pressId],
    );
    await client.query("COMMIT");
    return { kind: "skipped", localTime: schedule.local_time, title: schedule.title };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Due occurrences before a scenario's skip pass to its first occurrence at or after the skip's end,
 * through the same calendar arithmetic its completion uses.
 */
export async function passSkippedAgentSchedules(client: PoolClient, now: Date): Promise<number> {
  const due = await client.query<{
    check_until: Date | null; id: string; recurrence_kind: AgentScheduleRecurrenceKind; skipped_until: Date;
  }>(
    `SELECT id, recurrence_kind, check_until, skipped_until
       FROM agent_schedules
      WHERE status = 'active' AND next_run_at <= $1
        AND skipped_until IS NOT NULL AND next_run_at < skipped_until
      ORDER BY next_run_at, id
      FOR UPDATE SKIP LOCKED`,
    [now],
  );
  for (const schedule of due.rows) {
    // An occurrence exactly at the skip's end runs: the search returns the first one after its argument.
    const after = new Date(schedule.skipped_until.getTime() - 1);
    const next = await nextAgentScheduleOccurrence(client, schedule.id, schedule.recurrence_kind, after);
    if (next === null || (schedule.check_until !== null && next.next_run_at > schedule.check_until)) {
      await client.query(
        "UPDATE agent_schedules SET status = 'completed', attempts = 0, last_error_code = NULL, updated_at = $2 WHERE id = $1",
        [schedule.id, now],
      );
      continue;
    }
    await client.query(
      `UPDATE agent_schedules
          SET next_run_at = $2, occurrence_index = $3, attempts = 0, last_error_code = NULL, updated_at = $4
        WHERE id = $1`,
      [schedule.id, next.next_run_at, next.next_index, now],
    );
  }
  return due.rows.length;
}
