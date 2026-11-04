/**
 * What saving a person's timezone does to their reminders (#451).
 *
 * Export:
 * - `TimezoneApplication`: what became of the person's waits and reminders, for the model to tell.
 * - `applyTimezoneToReminders`: in the settings transaction, sets the waits and corrects a guessed zone.
 *
 * Key constructs:
 * - Waits become reminders at the clock time the person named, read in the saved zone. A one-time wait
 *   whose time has passed is not delivered late: it is reported as missed. A repeating one starts at
 *   its next occurrence. A family wait whose group is gone is missed too.
 * - When the zone being replaced was the agent's guess, the person's own reminders created since
 *   that guess keep their clock time in the corrected zone. Family reminders follow the family's
 *   clock, reminders that came from Google events keep the moment of the event, and a countdown is an
 *   exact moment, so none of them moves. A one-time reminder that the correction puts in the past is
 *   paused, not delivered at once. One being delivered at that second is left and logged.
 * - A person's zone is theirs in every family, so their waits in each family are set.
 */
import type { PoolClient } from "pg";

import { nextAnchoredOccurrence } from "../scheduling/next-occurrence.js";
import { REMINDER_TZ_RECENTLY_EXPIRED_DAYS } from "./reminder-config.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import { insertReminder } from "./reminder-insert.js";
import { type ReminderRecurrenceUnit } from "./reminder-record.js";
import { WAIT_COLUMNS, type WaitRow } from "./reminder-timezone-wait-repository.js";

export interface TimezoneApplication {
  activated: Array<{ content: string; id: string; nextRunAt: string }>;
  expiredRecently: Array<{ content: string; localFirstRun: string }>;
  missed: Array<{ content: string; localFirstRun: string; reason: "group_gone" | "time_passed" }>;
  shifted: Array<{ content: string; id: string; nextRunAt: string }>;
  shiftedIntoPast: Array<{ content: string; id: string; pausedAt: string }>;
}

interface WaitDestination extends WaitRow {
  family_id: string;
  forum_topic_id: string | null;
  group_id: string | null;
  message_thread_id: string | null;
  telegram_chat_id: string;
}

interface ShiftedRow {
  content: string;
  due_at: Date;
  id: string;
  recurrence_unit: ReminderRecurrenceUnit | null;
}

async function advanceToFuture(client: PoolClient, id: string, now: Date): Promise<Date> {
  const next = await nextAnchoredOccurrence(client, "reminders", id, now);
  await client.query(
    "UPDATE reminders SET occurrence_index = $2, due_at = $3, available_at = $3, updated_at = $4 WHERE id = $1",
    [id, next.next_index, next.next_run_at, now],
  );
  return new Date(next.next_run_at);
}

async function groupStillRegistered(client: PoolClient, wait: WaitDestination): Promise<boolean> {
  if (wait.scope === "personal") return true;
  const group = await client.query(
    `SELECT 1 FROM telegram_groups WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = 'family_private'`,
    [wait.group_id, wait.family_id, wait.telegram_chat_id],
  );
  return (group.rowCount ?? 0) > 0;
}

async function resolveWait(client: PoolClient, id: string, status: "activated" | "missed", now: Date, reminderId: string | null) {
  await client.query(
    `UPDATE reminder_timezone_waits
     SET status = $2, reminder_id = $3, resolved_at = $4, next_followup_at = NULL, updated_at = $4
     WHERE id = $1`,
    [id, status, reminderId, now],
  );
}

async function activateWaits(
  client: PoolClient,
  auth: ReminderAuthorization,
  timezone: string,
  now: Date,
  result: TimezoneApplication,
): Promise<void> {
  const waits = await client.query<WaitDestination>(
    `SELECT ${WAIT_COLUMNS}, family_id, group_id, telegram_chat_id, message_thread_id::text, forum_topic_id::text
     FROM reminder_timezone_waits
     WHERE author_user_id = $1 AND status = 'waiting'
     ORDER BY local_first_run, id
     FOR UPDATE`,
    [auth.userId],
  );
  for (const wait of waits.rows) {
    const localFirstRun = wait.local_first_run.slice(0, 16);
    if (!await groupStillRegistered(client, wait)) {
      await resolveWait(client, wait.id, "missed", now, null);
      result.missed.push({ content: wait.content, localFirstRun, reason: "group_gone" });
      continue;
    }
    const at = await client.query<{ at: Date }>("SELECT ($1::timestamp AT TIME ZONE $2) AS at", [wait.local_first_run, timezone]);
    const firstRunAt = at.rows[0]!.at;
    const recurring = wait.recurrence_unit !== null && wait.recurrence_interval !== null;
    if (!recurring && firstRunAt.getTime() <= now.getTime()) {
      await resolveWait(client, wait.id, "missed", now, null);
      result.missed.push({ content: wait.content, localFirstRun, reason: "time_passed" });
      continue;
    }
    const personal = wait.scope === "personal";
    const reminder = await insertReminder(client, {
      authorUserId: wait.author_user_id,
      buttons: wait.reply_buttons,
      content: wait.content,
      familyId: wait.family_id,
      firstRunAt,
      forumTopicId: personal ? null : wait.forum_topic_id,
      groupId: personal ? null : wait.group_id,
      messageThreadId: personal ? null : wait.message_thread_id,
      ownerUserId: wait.owner_user_id,
      recurrence: recurring ? { interval: wait.recurrence_interval!, unit: wait.recurrence_unit! } : null,
      scope: wait.scope,
      telegramChatId: wait.telegram_chat_id,
      timezone,
    }, { inputHash: wait.input_hash, operationKey: `wait:${wait.id}` }, { source: "timezone_wait" });
    const nextRunAt = firstRunAt.getTime() <= now.getTime()
      ? await advanceToFuture(client, reminder.id, now)
      : firstRunAt;
    await resolveWait(client, wait.id, "activated", now, reminder.id);
    result.activated.push({ content: wait.content, id: reminder.id, nextRunAt: nextRunAt.toISOString() });
  }
  // Named once: a later save of the settings, quiet hours for one, does not repeat them.
  const expired = await client.query<{ content: string; local_first_run: string }>(
    `UPDATE reminder_timezone_waits
     SET expiry_reported_at = $2, updated_at = $2
     WHERE author_user_id = $1 AND status = 'expired' AND expiry_reported_at IS NULL
       AND resolved_at >= $2::timestamptz - make_interval(days => $3)
     RETURNING content, to_char(local_first_run, 'YYYY-MM-DD"T"HH24:MI') AS local_first_run`,
    [auth.userId, now, REMINDER_TZ_RECENTLY_EXPIRED_DAYS],
  );
  result.expiredRecently.push(...expired.rows
    .sort((left, right) => left.local_first_run.localeCompare(right.local_first_run))
    .map((row) => ({ content: row.content, localFirstRun: row.local_first_run })));
}

async function shiftGuessedReminders(
  client: PoolClient,
  auth: ReminderAuthorization,
  guess: { setAt: Date; timezone: string },
  timezone: string,
  now: Date,
  result: TimezoneApplication,
): Promise<void> {
  // Expressions read the row before the update, so the old zone converts the old moment.
  const shifted = await client.query<ShiftedRow>(
    `UPDATE reminders AS reminder
     SET timezone = $5,
         due_at = (reminder.due_at AT TIME ZONE reminder.timezone) AT TIME ZONE $5,
         available_at = (reminder.due_at AT TIME ZONE reminder.timezone) AT TIME ZONE $5,
         recurrence_anchor_at = CASE WHEN reminder.recurrence_anchor_at IS NULL THEN NULL
                                     ELSE reminder.recurrence_anchor_local AT TIME ZONE $5 END,
         delayed_by_quiet_hours = false,
         updated_at = $6
     WHERE reminder.family_id = $1 AND reminder.author_user_id = $2 AND reminder.scope = 'personal'
       AND reminder.timezone = $3 AND reminder.created_at >= $4
       AND reminder.status IN ('active', 'paused')
       AND NOT EXISTS (
         SELECT 1 FROM audit_events AS event
         WHERE event.family_id = reminder.family_id AND event.subject_id = reminder.id
           AND event.event_type = 'reminder.created'
           AND (event.metadata ->> 'source' = 'google_calendar' OR event.metadata ->> 'time' = 'countdown')
       )
     RETURNING reminder.id, reminder.content, reminder.due_at, reminder.recurrence_unit`,
    [auth.familyId, auth.userId, guess.timezone, guess.setAt, timezone, now],
  );
  const delivering = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM reminders
     WHERE family_id = $1 AND author_user_id = $2 AND scope = 'personal' AND timezone = $3
       AND created_at >= $4 AND status = 'leased'`,
    [auth.familyId, auth.userId, guess.timezone, guess.setAt],
  );
  if (delivering.rows[0]!.count !== "0") {
    console.warn(JSON.stringify({
      code: "AGENT_NOTIFICATION_TIMEZONE_SHIFT_SKIPPED", count: Number(delivering.rows[0]!.count),
      familyId: auth.familyId, reason: "being_delivered",
    }));
  }
  for (const row of shifted.rows) {
    if (row.due_at.getTime() > now.getTime()) {
      result.shifted.push({ content: row.content, id: row.id, nextRunAt: row.due_at.toISOString() });
    } else if (row.recurrence_unit !== null) {
      const next = await advanceToFuture(client, row.id, now);
      result.shifted.push({ content: row.content, id: row.id, nextRunAt: next.toISOString() });
    } else {
      await client.query("UPDATE reminders SET status = 'paused', updated_at = $2 WHERE id = $1", [row.id, now]);
      result.shiftedIntoPast.push({ content: row.content, id: row.id, pausedAt: row.due_at.toISOString() });
    }
  }
}

export async function applyTimezoneToReminders(
  client: PoolClient,
  input: {
    auth: ReminderAuthorization;
    /** The zone being replaced when the agent had guessed it; null when there is nothing to correct. */
    guess: { setAt: Date; timezone: string } | null;
    now: Date;
    timezone: string;
  },
): Promise<TimezoneApplication> {
  const result: TimezoneApplication = { activated: [], expiredRecently: [], missed: [], shifted: [], shiftedIntoPast: [] };
  if (input.guess !== null && input.guess.timezone !== input.timezone) {
    await shiftGuessedReminders(client, input.auth, input.guess, input.timezone, input.now, result);
  }
  await activateWaits(client, input.auth, input.timezone, input.now, result);
  for (const [code, count] of [
    ["AGENT_REMINDER_AWAITING_ACTIVATED", result.activated.length],
    ["AGENT_REMINDER_AWAITING_MISSED", result.missed.length],
    ["AGENT_NOTIFICATION_TIMEZONE_CORRECTED", result.shifted.length + result.shiftedIntoPast.length],
  ] as const) {
    if (count > 0) console.info(JSON.stringify({ code, count, familyId: input.auth.familyId, userId: input.auth.userId }));
  }
  return result;
}
