/**
 * Scoped PostgreSQL reminder settings and CRUD boundary.
 *
 * Exports:
 * - `ReminderCreateInput` and `ReminderUpdateInput`: validated domain mutation inputs.
 * - `reminderRepository`: notification settings plus replay-safe create/list/update/delete.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { REMINDER_LIST_LIMIT } from "./reminder-config.js";
import type { ReminderAuthorization } from "./reminder-context.js";
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
  findReminderOperation,
  requireCurrentMembership,
  requireReminderMutationAccess,
  requireTimezone,
  selectReminder,
} from "./reminder-repository-helpers.js";
import {
  type NotificationSettingsInput,
  requireQuietHours,
  requireReminderContent,
  requireReminderDate,
  requireReminderRecurrence,
} from "./reminder-validation.js";

export interface ReminderCreateInput {
  content: string;
  firstRunAt: Date;
  operationKey: string;
  recurrence: ReminderRecurrence | null;
  scope: ReminderScope;
  timezone: string;
}

export interface ReminderUpdateInput {
  content?: string;
  enabled?: boolean;
  firstRunAt?: Date;
  operationKey: string;
  recurrence?: ReminderRecurrence | null;
}

export const reminderRepository = {
  async configureNotifications(
    auth: ReminderAuthorization,
    input: NotificationSettingsInput,
  ): Promise<{ quietEnd: string | null; quietStart: string | null; timezone: string }> {
    requireQuietHours(input);
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentMembership(client, auth);
      const timezone = await requireTimezone(client, input.timezone);
      await client.query(
        `INSERT INTO user_notification_settings (user_id, timezone, quiet_start, quiet_end)
         VALUES ($1, $2, $3::time, $4::time)
         ON CONFLICT (user_id) DO UPDATE
         SET timezone = EXCLUDED.timezone, quiet_start = EXCLUDED.quiet_start,
             quiet_end = EXCLUDED.quiet_end, updated_at = now()`,
        [auth.userId, timezone, input.quietStart, input.quietEnd],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, metadata)
         VALUES ($1, $2, 'notifications.configured',
                 jsonb_build_object('timezone', $3::text, 'quietHoursEnabled', $4::boolean))`,
        [auth.familyId, auth.userId, timezone, input.quietStart !== null],
      );
      await client.query("COMMIT");
      return { ...input, timezone };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async getNotificationSettings(
    auth: ReminderAuthorization,
  ): Promise<{ quietEnd: string | null; quietStart: string | null; timezone: string }> {
    const result = await database().query<{
      quiet_end: string | null;
      quiet_start: string | null;
      timezone: string;
    }>(
      `SELECT to_char(settings.quiet_end, 'HH24:MI') AS quiet_end,
              to_char(settings.quiet_start, 'HH24:MI') AS quiet_start,
              settings.timezone
       FROM user_notification_settings AS settings
       JOIN family_memberships AS membership ON membership.user_id = settings.user_id
       WHERE settings.user_id = $1 AND membership.family_id = $2`,
      [auth.userId, auth.familyId],
    );
    const settings = result.rows[0];
    if (!settings) {
      throw new AppError(
        "AGENT_NOTIFICATION_SETTINGS_REQUIRED",
        "Часовой пояс и тихие часы ещё не настроены",
      );
    }
    return {
      quietEnd: settings.quiet_end,
      quietStart: settings.quiet_start,
      timezone: settings.timezone,
    };
  },

  async create(auth: ReminderAuthorization, input: ReminderCreateInput): Promise<ReminderRecord> {
    const content = requireReminderContent(input.content);
    const firstRunAt = requireReminderDate(input.firstRunAt);
    const recurrence = requireReminderRecurrence(input.recurrence);
    const inputHash = reminderOperationHash({ ...input, content, firstRunAt: firstRunAt.toISOString() });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireCurrentMembership(client, auth);
      const replay = await findReminderOperation(client, auth, input.operationKey, "create", inputHash);
      if (replay !== undefined) {
        if (!replay) {
          throw new AppError(
            "AGENT_REMINDER_ALREADY_DELETED",
            "Это напоминание уже было создано и затем удалено",
          );
        }
        const existing = await selectReminder(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание уже удалено");
        await client.query("COMMIT");
        return rowToReminder(existing);
      }
      const settings = await client.query<{ timezone: string }>(
        "SELECT timezone FROM user_notification_settings WHERE user_id = $1",
        [auth.userId],
      );
      const timezone = settings.rows[0]?.timezone;
      if (!timezone) {
        throw new AppError(
          "AGENT_NOTIFICATION_SETTINGS_REQUIRED",
          "Сначала укажите часовой пояс и тихие часы для уведомлений",
        );
      }
      if (input.timezone !== timezone) {
        throw new AppError(
          "AGENT_REMINDER_TIMEZONE_MISMATCH",
          `Подтвердите время в настроенном часовом поясе ${timezone}`,
        );
      }

      // Destination is accepted only from the verified current Telegram conversation.
      const personal = input.scope === "personal";
      if (personal && auth.telegramChatType !== "private") {
        throw new AppError(
          "AGENT_REMINDER_DESTINATION_INVALID",
          "Личное напоминание можно создать только в личном чате",
        );
      }
      if (!personal && (auth.groupType !== "family_private" || !auth.groupId)) {
        throw new AppError(
          "AGENT_REMINDER_DESTINATION_INVALID",
          "Семейное напоминание создаётся в зарегистрированной семейной группе",
        );
      }
      if (!personal) {
        const group = await client.query(
          `SELECT 1 FROM telegram_groups
           WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = 'family_private'`,
          [auth.groupId, auth.familyId, auth.telegramChatId],
        );
        if (!group.rowCount) {
          throw new AppError(
            "AGENT_REMINDER_DESTINATION_INVALID",
            "Семейная группа больше не зарегистрирована",
          );
        }
      }
      const inserted = await client.query<ReminderRow>(
        `INSERT INTO reminders
           (family_id, owner_user_id, author_user_id, group_id, scope, content, timezone,
            telegram_chat_id, message_thread_id, recurrence_unit, recurrence_interval,
            recurrence_anchor_local, due_at, available_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11,
                 $12::timestamptz AT TIME ZONE $7, $12, $12)
         RETURNING ${REMINDER_COLUMNS}`,
        [
          auth.familyId,
          personal ? auth.userId : null,
          auth.userId,
          personal ? null : auth.groupId,
          input.scope,
          content,
          timezone,
          auth.telegramChatId,
          personal ? null : auth.messageThreadId,
          recurrence?.unit ?? null,
          recurrence?.interval ?? null,
          firstRunAt,
        ],
      );
      const reminder = inserted.rows[0]!;
      await client.query(
        `INSERT INTO reminder_operations
           (family_id, operation_key, operation_kind, input_hash, reminder_id)
         VALUES ($1, $2, 'create', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, reminder.id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'reminder.created', $3,
                 jsonb_build_object('scope', $4::text, 'recurrence', $5::text))`,
        [auth.familyId, auth.userId, reminder.id, input.scope, recurrence?.unit ?? "once"],
      );
      await client.query("COMMIT");
      return rowToReminder(reminder);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async list(auth: ReminderAuthorization): Promise<ReminderRecord[]> {
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
       ORDER BY reminder.created_at DESC, reminder.id DESC
       LIMIT $3`,
      [auth.familyId, auth.userId, REMINDER_LIST_LIMIT],
    );
    return result.rows.map(rowToReminder);
  },

  async update(
    auth: ReminderAuthorization,
    id: string,
    input: ReminderUpdateInput,
  ): Promise<ReminderRecord> {
    if (input.content === undefined && input.enabled === undefined && input.firstRunAt === undefined && input.recurrence === undefined) {
      throw new AppError("AGENT_REMINDER_UPDATE_INVALID", "Не указаны изменения напоминания");
    }
    const content = input.content === undefined ? undefined : requireReminderContent(input.content);
    const firstRunAt = input.firstRunAt === undefined ? undefined : requireReminderDate(input.firstRunAt);
    const recurrence = input.recurrence === undefined ? undefined : requireReminderRecurrence(input.recurrence);
    const inputHash = reminderOperationHash({ ...input, content, firstRunAt: firstRunAt?.toISOString() });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(client, auth, input.operationKey, "update", inputHash);
      if (replay) {
        const existing = await selectReminder(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание уже удалено");
        await client.query("COMMIT");
        return rowToReminder(existing);
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
      await requireReminderMutationAccess(client, auth, reminder);
      if (reminder.status === "leased") {
        throw new AppError(
          "AGENT_REMINDER_DELIVERY_IN_PROGRESS",
          "Напоминание сейчас отправляется. Повторите изменение после завершения доставки",
        );
      }
      if (input.enabled === true && reminder.status === "completed" && !firstRunAt) {
        throw new AppError(
          "AGENT_REMINDER_TIME_REQUIRED",
          "Для повторного запуска завершённого напоминания укажите новое время",
        );
      }
      const scheduleChanged = firstRunAt !== undefined || recurrence !== undefined;
      const nextDue = firstRunAt ?? reminder.due_at;
      const nextRecurrence = recurrence === undefined
        ? reminder.recurrence_unit && reminder.recurrence_interval
          ? { interval: reminder.recurrence_interval, unit: reminder.recurrence_unit }
          : null
        : recurrence;
      const updated = await client.query<ReminderRow>(
        `UPDATE reminders
         SET content = $2,
             recurrence_unit = $3, recurrence_interval = $4,
             recurrence_anchor_local = CASE WHEN $5 THEN $6::timestamptz AT TIME ZONE timezone ELSE recurrence_anchor_local END,
             occurrence_index = CASE WHEN $5 THEN 0 ELSE occurrence_index END,
             due_at = CASE WHEN $5 THEN $6 ELSE due_at END,
             available_at = CASE WHEN $5 THEN $6 ELSE available_at END,
             delayed_by_quiet_hours = CASE WHEN $5 THEN false ELSE delayed_by_quiet_hours END,
              status = CASE WHEN $7 = false THEN 'paused'::reminder_status
                           WHEN $7 = true THEN 'active'::reminder_status ELSE status END,
             attempts = CASE WHEN $5 OR $7 = true THEN 0 ELSE attempts END,
             last_error_code = CASE WHEN $5 OR $7 = true THEN NULL ELSE last_error_code END,
             updated_at = now()
         WHERE id = $1
         RETURNING ${REMINDER_COLUMNS}`,
        [
          id,
          content ?? reminder.content,
          nextRecurrence?.unit ?? null,
          nextRecurrence?.interval ?? null,
          scheduleChanged,
          nextDue,
          input.enabled ?? null,
        ],
      );
      await client.query(
        `INSERT INTO reminder_operations
           (family_id, operation_key, operation_kind, input_hash, reminder_id)
         VALUES ($1, $2, 'update', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'reminder.updated', $3, '{}'::jsonb)`,
        [auth.familyId, auth.userId, id],
      );
      await client.query("COMMIT");
      return rowToReminder(updated.rows[0]!);
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
      const replay = await findReminderOperation(client, auth, operationKey, "delete", inputHash);
      if (replay !== undefined) {
        await client.query("COMMIT");
        return true;
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw new AppError("AGENT_REMINDER_NOT_FOUND", "Напоминание не найдено");
      await requireReminderMutationAccess(client, auth, reminder);
      if (reminder.status === "leased") {
        throw new AppError(
          "AGENT_REMINDER_DELIVERY_IN_PROGRESS",
          "Напоминание сейчас отправляется. Повторите удаление после завершения доставки",
        );
      }
      await client.query(
        `INSERT INTO reminder_operations
           (family_id, operation_key, operation_kind, input_hash, reminder_id)
         VALUES ($1, $2, 'delete', $3, $4)`,
        [auth.familyId, operationKey, inputHash, id],
      );
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
