/**
 * Reminder changes that come from a person's edits in Google Calendar.
 *
 * Exports:
 * - `deleteReminderFromCalendar`: a copy deleted in Google deletes its reminder.
 * - `applyCalendarEdit`: a copy moved, renamed or re-repeated in Google changes its reminder.
 * - `createReminderFromEvent`: a person's own event in the mirror calendar becomes a reminder.
 *
 * Each change runs in one transaction with the copy it came from, so a retried cycle sees the event
 * as already handled. A reminder being delivered right now is left for the next minute. Every
 * change is audited with `source: google_calendar`.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";
import { REMINDER_CONTENT_MAX_LENGTH } from "../reminders/reminder-config.js";
import type { ReminderStatus } from "../reminders/reminder-record.js";
import { nextAnchoredOccurrence } from "../scheduling/next-occurrence.js";
import type { CalendarMirrorActor, CalendarMirrorProfile, MirrorRecurrence } from "./calendar-mirror-contract.js";
import { CALENDAR_MIRROR_ALL_DAY_REMINDER_TIME } from "./calendar-mirror-config.js";
import { instantToLocal, recurrenceAnchor } from "./calendar-mirror-local-time.js";

const AUDIT_SOURCE = "google_calendar";

export interface CalendarRecurrence {
  anchorDay: number;
  anchorMonth: number;
  recurrence: MirrorRecurrence;
}

export interface CalendarSchedule {
  recurrence: CalendarRecurrence | null;
  /**
   * The intended local start in the reminder's zone. A copy shown later by quiet hours keeps its
   * unshifted start here, so the delay is never written into the reminder itself.
   */
  startLocal: string;
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function audit(
  client: PoolClient,
  input: { actorUserId: string; eventType: string; familyId: string; metadata?: Record<string, unknown>; reminderId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [input.familyId, input.actorUserId, input.eventType, input.reminderId, JSON.stringify({ ...input.metadata, source: AUDIT_SOURCE })],
  );
}

/**
 * Sets the reminder's schedule from an anchor and moves a series anchored in the past to its next
 * run, with the same arithmetic the dispatcher uses.
 */
async function scheduleFrom(
  client: PoolClient,
  reminderId: string,
  anchorLocal: string,
  recurrence: MirrorRecurrence | null,
  now: Date,
): Promise<void> {
  const updated = await client.query<{ due_at: Date }>(
    `UPDATE reminders
     SET recurrence_unit = $2::reminder_recurrence_unit, recurrence_interval = $3,
         recurrence_anchor_local = $4::timestamp,
         recurrence_anchor_at = $4::timestamp AT TIME ZONE timezone,
         occurrence_index = 0,
         due_at = $4::timestamp AT TIME ZONE timezone,
         available_at = $4::timestamp AT TIME ZONE timezone,
         delayed_by_quiet_hours = false, attempts = 0, last_error_code = NULL, updated_at = now()
     WHERE id = $1
     RETURNING due_at`,
    [reminderId, recurrence?.unit ?? null, recurrence?.interval ?? null, anchorLocal],
  );
  if (recurrence === null || updated.rows[0]!.due_at > now) return;
  const next = await nextAnchoredOccurrence(client, "reminders", reminderId, now);
  await client.query(
    "UPDATE reminders SET due_at = $2, available_at = $2, occurrence_index = $3 WHERE id = $1",
    [reminderId, next.next_run_at, next.next_index],
  );
}

async function localInstant(client: PoolClient, local: string, timeZone: string): Promise<Date> {
  const result = await client.query<{ at: Date }>("SELECT ($1::timestamp AT TIME ZONE $2) AS at", [local, timeZone]);
  return result.rows[0]!.at;
}

function anchorOf(startLocal: string, recurrence: CalendarRecurrence | null): string {
  return recurrence === null
    ? startLocal
    : recurrenceAnchor(startLocal, { day: recurrence.anchorDay, month: recurrence.anchorMonth, unit: recurrence.recurrence.unit });
}

function boundedContent(content: string): string {
  return content.slice(0, REMINDER_CONTENT_MAX_LENGTH);
}

export type CalendarDeleteResult = "busy" | "deleted";

export async function deleteReminderFromCalendar(input: {
  actorUserId: string;
  copyId: string;
  familyId: string;
  reminderId: string;
}): Promise<CalendarDeleteResult> {
  return await inTransaction(async (client) => {
    const reminder = await client.query<{ scope: string; status: ReminderStatus }>(
      "SELECT scope::text AS scope, status FROM reminders WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [input.reminderId, input.familyId],
    );
    const row = reminder.rows[0];
    if (row?.status === "leased") return "busy";
    if (row) {
      await audit(client, {
        actorUserId: input.actorUserId,
        eventType: "reminder.deleted",
        familyId: input.familyId,
        metadata: { scope: row.scope },
        reminderId: input.reminderId,
      });
      await client.query("DELETE FROM reminders WHERE id = $1", [input.reminderId]);
    }
    await client.query("DELETE FROM calendar_mirror_copies WHERE id = $1", [input.copyId]);
    return "deleted";
  });
}

export interface CalendarEdit {
  /** The whole new reminder text; only its first line comes from Google. */
  content?: string;
  schedule?: CalendarSchedule;
}

export type CalendarEditResult = "applied" | "busy" | "delivered" | "missing" | { unsupported: "past" };

export async function applyCalendarEdit(input: {
  actorUserId: string;
  copyId: string;
  edit: CalendarEdit;
  etag: string | null;
  eventUpdated: Date | null;
  familyId: string;
  now: Date;
  reminderId: string;
}): Promise<CalendarEditResult> {
  return await inTransaction(async (client) => {
    const reminder = await client.query<{ status: ReminderStatus; timezone: string }>(
      "SELECT status, timezone FROM reminders WHERE id = $1 AND family_id = $2 FOR UPDATE",
      [input.reminderId, input.familyId],
    );
    const row = reminder.rows[0];
    if (!row) return "missing";
    if (row.status === "leased") return "busy";
    if (row.status === "completed") return "delivered";

    const schedule = input.edit.schedule;
    if (schedule !== undefined) {
      if (schedule.recurrence === null && await localInstant(client, schedule.startLocal, row.timezone) <= input.now) {
        return { unsupported: "past" as const };
      }
      await scheduleFrom(
        client,
        input.reminderId,
        anchorOf(schedule.startLocal, schedule.recurrence),
        schedule.recurrence?.recurrence ?? null,
        input.now,
      );
    }
    if (input.edit.content !== undefined) {
      await client.query(
        "UPDATE reminders SET content = $2, updated_at = now() WHERE id = $1",
        [input.reminderId, boundedContent(input.edit.content)],
      );
    }
    await client.query(
      "UPDATE calendar_mirror_copies SET etag = $2, event_updated = $3, updated_at = now() WHERE id = $1",
      [input.copyId, input.etag, input.eventUpdated],
    );
    await audit(client, {
      actorUserId: input.actorUserId,
      eventType: "reminder.updated",
      familyId: input.familyId,
      reminderId: input.reminderId,
    });
    return "applied";
  });
}

export type CreateFromEventResult = "no_family_group" | "past" | "settings_missing" | { reminderId: string };

export async function createReminderFromEvent(input: {
  actor: CalendarMirrorActor;
  content: string;
  etag: string | null;
  eventId: string;
  eventUpdated: Date | null;
  now: Date;
  profile: CalendarMirrorProfile;
  recurrence: CalendarRecurrence | null;
  start: { allDayDate: string } | { instant: Date };
}): Promise<CreateFromEventResult> {
  const { profile } = input;
  const personal = profile.scope === "personal";
  // A personal profile's reminders are its owner's; family reminders are written for the family owner.
  const authorId = personal ? profile.ownerUserId : input.actor.userId;
  if (authorId === null) throw new Error("AGENT_CALENDAR_MIRROR_PROFILE_OWNER_MISSING: у личного профиля нет хозяина");

  return await inTransaction(async (client) => {
    const existing = await client.query<{ reminder_id: string }>(
      `SELECT reminder_id FROM calendar_mirror_copies
       WHERE workspace_id = $1 AND event_id = $2 AND kind = 'copy' AND reminder_id IS NOT NULL`,
      [profile.workspaceId, input.eventId],
    );
    if (existing.rows[0]) return { reminderId: existing.rows[0].reminder_id };

    const settings = await client.query<{ telegram_user_id: string; timezone: string }>(
      `SELECT settings.timezone, author.telegram_user_id
       FROM user_notification_settings AS settings JOIN users AS author ON author.id = settings.user_id
       WHERE settings.user_id = $1`,
      [authorId],
    );
    const author = settings.rows[0];
    if (!author) return "settings_missing";

    const destination = personal
      ? { chatId: author.telegram_user_id, groupId: null }
      : await familyGroup(client, profile.familyId);
    if (destination === null) return "no_family_group";

    const startLocal = "instant" in input.start
      ? instantToLocal(input.start.instant, author.timezone)
      : `${input.start.allDayDate}T${CALENDAR_MIRROR_ALL_DAY_REMINDER_TIME}`;
    const anchorLocal = anchorOf(startLocal, input.recurrence);
    const recurrence = input.recurrence?.recurrence ?? null;
    if (recurrence === null && await localInstant(client, startLocal, author.timezone) <= input.now) return "past";

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO reminders
         (family_id, owner_user_id, author_user_id, group_id, scope, content, timezone, telegram_chat_id,
          recurrence_unit, recurrence_interval, recurrence_anchor_local, recurrence_anchor_at, due_at, available_at)
       VALUES ($1, $2, $3, $4, $5::reminder_scope, $6, $7, $8, NULL, NULL, $9::timestamp,
               $9::timestamp AT TIME ZONE $7, $9::timestamp AT TIME ZONE $7, $9::timestamp AT TIME ZONE $7)
       RETURNING id`,
      [
        profile.familyId,
        personal ? authorId : null,
        authorId,
        destination.groupId,
        profile.scope,
        boundedContent(input.content),
        author.timezone,
        destination.chatId,
        anchorLocal,
      ],
    );
    const reminderId = inserted.rows[0]!.id;
    if (recurrence !== null) await scheduleFrom(client, reminderId, anchorLocal, recurrence, input.now);
    await client.query(
      `INSERT INTO calendar_mirror_copies (workspace_id, kind, reminder_id, event_id, etag, event_updated)
       VALUES ($1, 'copy', $2, $3, $4, $5)
       ON CONFLICT (workspace_id, event_id) DO UPDATE
       SET kind = 'copy', reminder_id = EXCLUDED.reminder_id, etag = EXCLUDED.etag,
           event_updated = EXCLUDED.event_updated, fingerprint = NULL, pushed = NULL,
           rejected_fingerprint = NULL, updated_at = now()`,
      [profile.workspaceId, reminderId, input.eventId, input.etag, input.eventUpdated],
    );
    await audit(client, {
      actorUserId: input.actor.userId,
      eventType: "reminder.created",
      familyId: profile.familyId,
      metadata: { recurrence: recurrence?.unit ?? "once", scope: profile.scope },
      reminderId,
    });
    return { reminderId };
  });
}

/** Family reminders made in Google go to the family's earliest registered family group. */
async function familyGroup(client: PoolClient, familyId: string): Promise<{ chatId: string; groupId: string } | null> {
  const group = await client.query<{ id: string; telegram_chat_id: string }>(
    `SELECT id, telegram_chat_id FROM telegram_groups
     WHERE family_id = $1 AND type = 'family_private'
     ORDER BY created_at, id LIMIT 1`,
    [familyId],
  );
  const row = group.rows[0];
  return row ? { chatId: row.telegram_chat_id, groupId: row.id } : null;
}
