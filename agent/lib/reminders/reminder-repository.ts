/**
 * Scoped PostgreSQL reminder settings and CRUD boundary.
 *
 * Exports:
 * - `ReminderCreateInput` and `ReminderUpdateInput`: validated domain mutation inputs.
 * - `reminderRepository`: notification settings plus replay-safe create/list/update/delete, and
 *   whether a call's effect is already recorded.
 *
 * Key construct:
 * - The list holds only what is still ahead, soonest first: delivered reminders are found through
 *   the proactive delivery history instead.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { decodeDateUuidCursor, encodeDateUuidCursor, paginationFilterDigest } from "../keyset-pagination.js";
import { REMINDER_LIST_MAX_LIMIT } from "./reminder-config.js";
import type { ReminderAuthorization } from "./reminder-context.js";
import { createReminderOrWait } from "./reminder-create.js";
import {
  type ReminderRecord,
  type ReminderRecurrence,
  type ReminderRow,
  type ReminderScope,
  reminderOperationHash,
  rowToReminder,
} from "./reminder-record.js";
import {
  REMINDER_COLUMNS,
  REMINDER_LIVE_STATUSES,
  findReminderOperation,
  requireCurrentMembership,
  requireReminderMutationAccess,
  requireTimezone,
  selectReminder,
} from "./reminder-repository-helpers.js";
import {
  applyReminderUpdate,
  recordReminderOperation,
  requireReminderNotLeased,
} from "./reminder-mutation.js";
import { instantToLocal } from "../calendar-mirror/calendar-mirror-local-time.js";
import { applyTimezoneToReminders, type TimezoneApplication } from "./reminder-timezone-activation.js";
import {
  type NotificationSettingsInput,
  requireNotificationSettings,
  requireReminderContent,
  requireReminderDate,
  requireReminderRecurrence,
} from "./reminder-validation.js";

export interface ReminderCreateInput {
  /** Reply buttons sent with every delivery; absent for none. */
  buttons?: ReplyButtonRows;
  content: string;
  firstRunAt: Date;
  operationKey: string;
  recurrence: ReminderRecurrence | null;
  /** The group scope has its own boundary: it carries a Telegram author instead of an account. */
  scope: Exclude<ReminderScope, "group">;
  timezone: string;
}

export interface ReminderUpdateInput {
  buttons?: ReplyButtonRows | null;
  content?: string;
  enabled?: boolean;
  firstRunAt?: Date;
  operationKey: string;
  recurrence?: ReminderRecurrence | null;
}

export interface NotificationSettingsResult extends TimezoneApplication {
  /** The person's clock now, `YYYY-MM-DDTHH:MM`, so the agent can name it and the person can catch a wrong zone. */
  localTimeNow: string;
  quietEnd: string | null;
  quietStart: string | null;
  source: "agent" | "person";
  timezone: string;
}

export const reminderRepository = {
  /**
   * Saves the person's timezone and, in the same transaction, sets their waiting reminders and moves
   * the ones created under a zone the agent had guessed (#451). The agent sets a zone only where none
   * exists; any change of an existing zone comes from the person.
   */
  async configureNotifications(
    auth: ReminderAuthorization,
    input: NotificationSettingsInput,
    now: Date = new Date(),
  ): Promise<NotificationSettingsResult> {
    requireNotificationSettings(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentMembership(client, auth);
      const timezone = await requireTimezone(client, input.timezone);
      const current = await client.query<{
        quiet_end: string | null;
        quiet_start: string | null;
        timezone: string;
        timezone_set_at: Date;
        timezone_source: "agent" | "person";
      }>(
        `SELECT timezone, timezone_source, timezone_set_at, to_char(quiet_start, 'HH24:MI') AS quiet_start,
                to_char(quiet_end, 'HH24:MI') AS quiet_end
         FROM user_notification_settings WHERE user_id = $1 FOR UPDATE`,
        [auth.userId],
      );
      const existing = current.rows[0];
      if (input.source === "agent" && existing) {
        throw new AppError(
          "AGENT_NOTIFICATION_TIMEZONE_ALREADY_SET",
          `Часовой пояс уже указан (${existing.timezone}): менять его можно только по словам человека`,
        );
      }
      // Quiet hours are a person's choice: a new zone has none, and a zone change keeps those already set.
      const quietStart = input.quietStart !== undefined ? input.quietStart : existing?.quiet_start ?? null;
      const quietEnd = input.quietEnd !== undefined ? input.quietEnd : existing?.quiet_end ?? null;
      const zoneChanged = !existing || existing.timezone !== timezone || existing.timezone_source !== input.source;
      await client.query(
        `INSERT INTO user_notification_settings
           (user_id, timezone, quiet_start, quiet_end, timezone_source, timezone_basis, timezone_set_at)
         VALUES ($1, $2, $3::time, $4::time, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE
         SET timezone = EXCLUDED.timezone, quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
             timezone_source = EXCLUDED.timezone_source, timezone_basis = EXCLUDED.timezone_basis,
             timezone_set_at = CASE WHEN $8::boolean THEN EXCLUDED.timezone_set_at
                                    ELSE user_notification_settings.timezone_set_at END,
             updated_at = now()`,
        [auth.userId, timezone, quietStart, quietEnd, input.source, input.source === "agent" ? input.basis : null, now, zoneChanged],
      );
      const applied = await applyTimezoneToReminders(client, {
        auth,
        guess: existing?.timezone_source === "agent"
          ? { setAt: existing.timezone_set_at, timezone: existing.timezone }
          : null,
        now,
        timezone,
      });
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, $2, 'notifications.configured',
                 jsonb_build_object('timezone', $3::text, 'quietHoursEnabled', $4::boolean, 'source', $5::text,
                                    'activated', $6::int, 'shifted', $7::int))`,
        [auth.familyId, auth.userId, timezone, quietStart !== null, input.source, applied.activated.length,
          applied.shifted.length + applied.shiftedIntoPast.length],
      );
      if (input.source === "agent") {
        console.info(JSON.stringify({ code: "AGENT_NOTIFICATION_TIMEZONE_INFERRED", basis: input.basis, familyId: auth.familyId, timezone }));
      }
      await client.query("COMMIT");
      return {
        ...applied,
        localTimeNow: instantToLocal(now, timezone).slice(0, 16),
        quietEnd,
        quietStart,
        source: input.source,
        timezone,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async getNotificationSettings(
    auth: ReminderAuthorization,
  ): Promise<{ quietEnd: string | null; quietStart: string | null; source: "agent" | "person"; timezone: string }> {
    const result = await database().query<{
      quiet_end: string | null;
      quiet_start: string | null;
      timezone: string;
      timezone_source: "agent" | "person";
    }>(
      `SELECT to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              settings.timezone, settings.timezone_source
       FROM user_notification_settings AS settings
       JOIN family_memberships AS membership ON membership.user_id = settings.user_id
       WHERE settings.user_id = $1 AND membership.family_id = $2`,
      [auth.userId, auth.familyId],
    );
    const settings = result.rows[0];
    if (!settings) {
      throw new AppError(
        "AGENT_NOTIFICATION_SETTINGS_REQUIRED",
        "Часовой пояс ещё не известен",
      );
    }
    return {
      quietEnd: settings.quiet_end,
      quietStart: settings.quiet_start,
      source: settings.timezone_source,
      timezone: settings.timezone,
    };
  },

  /** An exact moment with its zone; the other ways of naming the time go through `createReminderOrWait`. */
  async create(auth: ReminderAuthorization, input: ReminderCreateInput): Promise<ReminderRecord> {
    const { firstRunAt, timezone, ...rest } = input;
    const outcome = await createReminderOrWait(auth, { ...rest, time: { at: firstRunAt, kind: "absolute", timezone } });
    if (outcome.kind !== "reminder") {
      throw new Error("AGENT_REMINDER_CREATE_INVARIANT: an exact moment never waits for a timezone");
    }
    return outcome.reminder;
  },

  async list(
    auth: ReminderAuthorization,
    options: { cursor?: string; limit: number },
  ): Promise<{ items: ReminderRecord[]; nextCursor: string | null }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > REMINDER_LIST_MAX_LIMIT) {
      throw new AppError("AGENT_REMINDER_LIMIT_INVALID", "Некорректный размер страницы напоминаний");
    }
    // The binding refuses a cursor of the former creation-time order instead of misreading it.
    const binding = paginationFilterDigest([auth.familyId, auth.userId]);
    const cursor = decodeDateUuidCursor(
      options.cursor,
      "AGENT_REMINDER_CURSOR_INVALID",
      "Не удалось продолжить просмотр напоминаний",
      binding,
    );
    const result = await database().query<ReminderRow>(
      `SELECT ${REMINDER_COLUMNS}
       FROM reminders AS reminder
       WHERE reminder.family_id = $1
         AND EXISTS (
           SELECT 1 FROM family_memberships
           WHERE family_id = $1 AND user_id = $2
         )
          AND (
             (reminder.scope = 'personal' AND reminder.owner_user_id = $2) OR
             reminder.scope = 'family'
           )
          AND reminder.status IN ${REMINDER_LIVE_STATUSES}
          AND ($3::timestamptz IS NULL OR (reminder.due_at, reminder.id) > ($3, $4::uuid))
        ORDER BY reminder.due_at, reminder.id
        LIMIT $5`,
      [auth.familyId, auth.userId, cursor?.timestamp ?? null, cursor?.id ?? null, options.limit + 1],
    );
    const hasNext = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(rowToReminder),
      nextCursor: hasNext && last ? encodeDateUuidCursor(last.due_at, last.id, binding) : null,
    };
  },

  /** Whether a call already left its effect under this key, so its replay is answered from that record. */
  async operationRecorded(auth: ReminderAuthorization, operationKey: string): Promise<boolean> {
    const result = await database().query(
      "SELECT 1 FROM reminder_operations WHERE family_id = $1 AND operation_key = $2",
      [auth.familyId, operationKey],
    );
    return result.rows.length > 0;
  },

  /** The scope of a reminder of this family, or null when there is none; a scope never changes. */
  async scopeOf(auth: ReminderAuthorization, id: string): Promise<ReminderScope | null> {
    const result = await database().query<{ scope: ReminderScope }>(
      "SELECT scope FROM reminders WHERE id = $1 AND family_id = $2",
      [id, auth.familyId],
    );
    return result.rows[0]?.scope ?? null;
  },

  async update(
    auth: ReminderAuthorization,
    id: string,
    input: ReminderUpdateInput,
  ): Promise<ReminderRecord> {
    if (input.buttons === undefined && input.content === undefined && input.enabled === undefined &&
      input.firstRunAt === undefined && input.recurrence === undefined) {
      throw new AppError("AGENT_REMINDER_UPDATE_INVALID", "Не указаны изменения напоминания");
    }
    const content = input.content === undefined ? undefined : requireReminderContent(input.content);
    const firstRunAt = input.firstRunAt === undefined ? undefined : requireReminderDate(input.firstRunAt);
    const recurrence = input.recurrence === undefined ? undefined : requireReminderRecurrence(input.recurrence);
    const inputHash = reminderOperationHash({ ...input, content, firstRunAt: firstRunAt?.toISOString() });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(client, auth.familyId, input.operationKey, "update", inputHash);
      if (replay) {
        const existing = await selectReminder(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание уже удалено");
        await client.query("COMMIT");
        return rowToReminder(existing);
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
      await requireReminderMutationAccess(client, auth, reminder);
      const updated = await applyReminderUpdate(client, reminder, {
        ...(input.buttons === undefined ? {} : { buttons: input.buttons }),
        ...(content === undefined ? {} : { content }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(firstRunAt === undefined ? {} : { firstRunAt }),
        ...(recurrence === undefined ? {} : { recurrence }),
      });
      await recordReminderOperation(client, {
        familyId: auth.familyId,
        inputHash,
        operationKey: input.operationKey,
        operationKind: "update",
        reminderId: id,
      });
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'reminder.updated', $3, '{}'::jsonb)`,
        [auth.familyId, auth.userId, id],
      );
      await client.query("COMMIT");
      return rowToReminder(updated);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async delete(auth: ReminderAuthorization, id: string, operationKey: string): Promise<boolean> {
    const inputHash = reminderOperationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(client, auth.familyId, operationKey, "delete", inputHash);
      if (replay !== undefined) {
        await client.query("COMMIT");
        return true;
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
      await requireReminderMutationAccess(client, auth, reminder);
      requireReminderNotLeased(reminder, "delete");
      await recordReminderOperation(client, {
        familyId: auth.familyId,
        inputHash,
        operationKey,
        operationKind: "delete",
        reminderId: id,
      });
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'reminder.deleted', $3, jsonb_build_object('scope', $4::text))`,
        [auth.familyId, auth.userId, id, reminder.scope],
      );
      await client.query("DELETE FROM reminders WHERE id = $1", [id]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
