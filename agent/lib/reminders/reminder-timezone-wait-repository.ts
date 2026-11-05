/**
 * Reminders named by the clock while the person's timezone is still unknown (#451).
 *
 * Exports:
 * - `AwaitingReminderRecord`: what the model sees of a waiting reminder.
 * - `suggestedTimezoneOf`: the zone offered on the button — the family's most common, else the product's.
 * - `timezoneLabel`: a short Russian name of a zone for a button, «Москва».
 * - `insertWait`, `findWaitReplay`: the wait written in the caller's create transaction, and its replay.
 * - `timezoneWaitRepository`: listing, changing and cancelling waits.
 *
 * A wait keeps the clock time the person named and becomes a reminder in the transaction that saves
 * the timezone (`reminder-timezone-activation.ts`). Until then the bot asks about the zone at most
 * twice (`reminder-timezone-followup.ts`) and the wait ends unanswered without a guessed delivery.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { replyButtonMarkup } from "../reply-buttons/reply-button-markup.js";
import { PRODUCT_SUGGESTED_TIMEZONE, REMINDER_TZ_AWAITING_LIST_LIMIT } from "./reminder-config.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import type { ReminderRecurrence, ReminderRecurrenceUnit } from "./reminder-record.js";
import { requireCurrentMembership } from "./reminder-repository-helpers.js";
import { followupSchedule } from "./reminder-timezone-followup-schedule.js";

export interface AwaitingReminderRecord {
  /** The text, followed by the markup of its reply buttons, as the model writes it. */
  content: string;
  createdAt: string;
  id: string;
  /** The clock time the person named, `YYYY-MM-DDTHH:MM`, in a zone not known yet. */
  localFirstRun: string;
  recurrence: ReminderRecurrence | null;
  scope: "family" | "personal";
  status: "awaiting_timezone";
  suggestedLabel: string;
  suggestedTimezone: string;
}

export interface WaitRow {
  author_user_id: string;
  content: string;
  created_at: Date;
  followups_sent: number;
  id: string;
  input_hash: string;
  local_first_run: string;
  owner_user_id: string | null;
  recurrence_interval: number | null;
  recurrence_unit: ReminderRecurrenceUnit | null;
  reply_buttons: ReplyButtonRows | null;
  scope: "family" | "personal";
  status: string;
}

export const WAIT_COLUMNS = `id, author_user_id, owner_user_id, scope, content, reply_buttons,
  to_char(local_first_run, 'YYYY-MM-DD"T"HH24:MI:SS') AS local_first_run, recurrence_unit,
  recurrence_interval, followups_sent, input_hash, status, created_at`;

/**
 * One person's reminder writes and timezone saves take turns. The runtime runs the calls of one
 * model step at once, so «save the zone» and «create the reminder» may race: without this lock a
 * wait inserted after the save looked for waits stays waiting while the zone exists, and nothing
 * asks about it again. Taken first in both transactions, before the settings are read.
 */
export async function lockPersonReminders(client: Pick<PoolClient, "query">, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`reminder-timezone:${userId}`]);
}

export async function suggestedTimezoneOf(client: Pick<PoolClient, "query">, familyId: string): Promise<string> {
  const result = await client.query<{ timezone: string }>(
    `SELECT settings.timezone
     FROM user_notification_settings AS settings
     JOIN family_memberships AS membership ON membership.user_id = settings.user_id
     WHERE membership.family_id = $1
     GROUP BY settings.timezone
     ORDER BY count(*) DESC, settings.timezone
     LIMIT 1`,
    [familyId],
  );
  return result.rows[0]?.timezone ?? PRODUCT_SUGGESTED_TIMEZONE;
}

/** A label for a button only: when ICU has no city name for the zone, its UTC offset is shown. */
export function timezoneLabel(timezone: string): string {
  const name = new Intl.DateTimeFormat("ru", { timeZone: timezone, timeZoneName: "shortGeneric" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value ?? timezone;
  return name.startsWith("GMT") ? name.replace("GMT", "UTC") : name;
}

function recurrenceOf(row: WaitRow): ReminderRecurrence | null {
  return row.recurrence_unit === null || row.recurrence_interval === null
    ? null
    : { interval: row.recurrence_interval, unit: row.recurrence_unit };
}

export function waitToRecord(row: WaitRow, suggestedTimezone: string): AwaitingReminderRecord {
  return {
    content: row.reply_buttons === null ? row.content : `${row.content}\n\n${replyButtonMarkup(row.reply_buttons)}`,
    createdAt: row.created_at.toISOString(),
    id: row.id,
    localFirstRun: row.local_first_run.slice(0, 16),
    recurrence: recurrenceOf(row),
    scope: row.scope,
    status: "awaiting_timezone",
    suggestedLabel: timezoneLabel(suggestedTimezone),
    suggestedTimezone,
  };
}

export interface WaitInsert {
  auth: ReminderAuthorization;
  buttons: ReplyButtonRows | null;
  content: string;
  inputHash: string;
  localFirstRun: string;
  now: Date;
  operationKey: string;
  recurrence: ReminderRecurrence | null;
  scope: "family" | "personal";
}

export async function insertWait(client: PoolClient, input: WaitInsert): Promise<AwaitingReminderRecord> {
  const { auth } = input;
  const personal = input.scope === "personal";
  const suggested = await suggestedTimezoneOf(client, auth.familyId);
  const schedule = followupSchedule({
    fromGroup: auth.telegramChatType !== "private",
    localFirstRun: input.localFirstRun,
    recurring: input.recurrence !== null,
    requestedAt: input.now,
    suggestedTimezone: suggested,
  });
  const inserted = await client.query<WaitRow>(
    `INSERT INTO reminder_timezone_waits
       (family_id, author_user_id, owner_user_id, group_id, scope, content, reply_buttons, telegram_chat_id,
        message_thread_id, forum_topic_id, local_first_run, recurrence_unit, recurrence_interval,
        operation_key, input_hash, expires_at, next_followup_at, second_followup_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::bigint, $10::bigint, $11::timestamp, $12, $13,
             $14, $15, $16, $17, $18, $19, $19)
     RETURNING ${WAIT_COLUMNS}`,
    [
      auth.familyId,
      auth.userId,
      personal ? auth.userId : null,
      personal ? null : auth.groupId,
      input.scope,
      input.content,
      input.buttons === null ? null : JSON.stringify(input.buttons),
      auth.telegramChatId,
      personal ? null : auth.messageThreadId,
      personal ? null : auth.forumTopicId,
      input.localFirstRun,
      input.recurrence?.unit ?? null,
      input.recurrence?.interval ?? null,
      input.operationKey,
      input.inputHash,
      schedule.expiresAt,
      schedule.first,
      schedule.second,
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, 'reminder.timezone_wait_created', $3, jsonb_build_object('scope', $4::text))`,
    [auth.familyId, auth.userId, inserted.rows[0]!.id, input.scope],
  );
  console.info(JSON.stringify({
    code: "AGENT_REMINDER_AWAITING_TIMEZONE",
    familyId: auth.familyId,
    followups: [schedule.first, schedule.second].filter((moment) => moment !== null).length,
    scope: input.scope,
    waitId: inserted.rows[0]!.id,
  }));
  return waitToRecord(inserted.rows[0]!, suggested);
}

/**
 * The wait an earlier call with this key left, with what became of it, or undefined; a key reused
 * with other input is refused.
 */
export async function findWaitReplay(
  client: PoolClient,
  familyId: string,
  operationKey: string,
  inputHash: string,
): Promise<{ record: AwaitingReminderRecord; reminderId: string | null; status: string } | undefined> {
  const result = await client.query<WaitRow & { reminder_id: string | null }>(
    `SELECT ${WAIT_COLUMNS}, reminder_id FROM reminder_timezone_waits WHERE family_id = $1 AND operation_key = $2`,
    [familyId, operationKey],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.input_hash !== inputHash) {
    throw new AppError("AGENT_REMINDER_OPERATION_CONFLICT", "Повтор операции напоминания содержит другие параметры");
  }
  return { record: waitToRecord(row, await suggestedTimezoneOf(client, familyId)), reminderId: row.reminder_id, status: row.status };
}

async function lockWaitForChange(client: PoolClient, auth: ReminderAuthorization, id: string): Promise<WaitRow | null> {
  const result = await client.query<WaitRow>(
    `SELECT ${WAIT_COLUMNS} FROM reminder_timezone_waits WHERE family_id = $1 AND id = $2 FOR UPDATE`,
    [auth.familyId, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const role = await requireCurrentMembership(client, auth);
  const allowed = row.scope === "personal"
    ? row.author_user_id === auth.userId
    : row.author_user_id === auth.userId || role === "owner";
  if (!allowed) {
    throw new AppError("AGENT_REMINDER_MUTATION_DENIED", "Изменить семейное напоминание может только его автор или владелец семьи");
  }
  return row;
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

function notWaiting(): AppError {
  return new AppError(
    "AGENT_REMINDER_AWAITING_RESOLVED",
    "Это напоминание уже не ждёт часового пояса: проверьте актуальный список через manage_reminder с action=list",
  );
}

export const timezoneWaitRepository = {
  /** The scope of a waiting or resolved wait with this id, or null when the id names no wait of the family. */
  async scopeOf(auth: ReminderAuthorization, id: string): Promise<"family" | "personal" | null> {
    const result = await database().query<{ scope: "family" | "personal" }>(
      "SELECT scope FROM reminder_timezone_waits WHERE family_id = $1 AND id = $2",
      [auth.familyId, id],
    );
    return result.rows[0]?.scope ?? null;
  },

  async operationRecorded(auth: ReminderAuthorization, operationKey: string): Promise<boolean> {
    const result = await database().query(
      "SELECT 1 FROM reminder_timezone_waits WHERE family_id = $1 AND operation_key = $2",
      [auth.familyId, operationKey],
    );
    return result.rows.length > 0;
  },

  async list(auth: ReminderAuthorization): Promise<AwaitingReminderRecord[]> {
    const result = await database().query<WaitRow>(
      `SELECT ${WAIT_COLUMNS}
       FROM reminder_timezone_waits AS wait
       WHERE wait.family_id = $1 AND wait.status = 'waiting'
         AND EXISTS (SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2)
         AND ((wait.scope = 'personal' AND wait.owner_user_id = $2) OR wait.scope = 'family')
       ORDER BY wait.local_first_run, wait.id
       LIMIT $3`,
      [auth.familyId, auth.userId, REMINDER_TZ_AWAITING_LIST_LIMIT],
    );
    const suggested = await suggestedTimezoneOf(database(), auth.familyId);
    return result.rows.map((row) => waitToRecord(row, suggested));
  },

  async update(
    auth: ReminderAuthorization,
    id: string,
    input: { buttons?: ReplyButtonRows | null; content?: string; localFirstRun?: string; now: Date },
  ): Promise<AwaitingReminderRecord> {
    return await inTransaction(async (client) => {
      const row = await lockWaitForChange(client, auth, id);
      if (!row) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
      if (row.status !== "waiting") throw notWaiting();
      const suggested = await suggestedTimezoneOf(client, auth.familyId);
      const local = input.localFirstRun ?? row.local_first_run;
      const schedule = followupSchedule({
        fromGroup: false,
        localFirstRun: local,
        recurring: row.recurrence_unit !== null,
        requestedAt: input.now,
        suggestedTimezone: suggested,
      });
      // A changed time asks again on the new schedule, still within the two follow-ups in total.
      const next = row.followups_sent === 0 ? schedule.first : row.followups_sent === 1 ? schedule.second : null;
      const updated = await client.query<WaitRow>(
        `UPDATE reminder_timezone_waits
         SET content = COALESCE($2, content),
             reply_buttons = CASE WHEN $3::boolean THEN $4::jsonb ELSE reply_buttons END,
             local_first_run = $5::timestamp,
             expires_at = CASE WHEN $7::boolean THEN $6 ELSE expires_at END,
             next_followup_at = CASE WHEN $7::boolean THEN $8 ELSE next_followup_at END,
             second_followup_at = CASE WHEN $7::boolean THEN $9 ELSE second_followup_at END,
             updated_at = $10
         WHERE id = $1
         RETURNING ${WAIT_COLUMNS}`,
        [
          id,
          input.content ?? null,
          input.buttons !== undefined,
          input.buttons === undefined || input.buttons === null ? null : JSON.stringify(input.buttons),
          local,
          schedule.expiresAt,
          input.localFirstRun !== undefined,
          next,
          row.followups_sent === 0 ? schedule.second : null,
          input.now,
        ],
      );
      return waitToRecord(updated.rows[0]!, suggested);
    });
  },

  async delete(auth: ReminderAuthorization, id: string, now: Date): Promise<boolean> {
    return await inTransaction(async (client) => {
      const row = await lockWaitForChange(client, auth, id);
      if (!row) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
      if (row.status === "deleted") return true;
      if (row.status !== "waiting") throw notWaiting();
      await client.query(
        "UPDATE reminder_timezone_waits SET status = 'deleted', resolved_at = $2, updated_at = $2 WHERE id = $1",
        [id, now],
      );
      return true;
    });
  },
};
