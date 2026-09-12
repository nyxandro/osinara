/**
 * Scoped PostgreSQL reminder settings and CRUD boundary.
 *
 * Exports:
 * - `ReminderCreateInput` and `ReminderUpdateInput`: validated domain mutation inputs.
 * - `reminderRepository`: notification settings plus replay-safe create/list/update/delete.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { decodeDateUuidCursor, encodeDateUuidCursor } from "../keyset-pagination.js";
import { REMINDER_LIST_MAX_LIMIT } from "./reminder-config.js";
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
  applyReminderUpdate,
  recordReminderOperation,
  requireReminderNotLeased,
} from "./reminder-mutation.js";
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
  /** The group scope has its own boundary: it carries a Telegram author instead of an account. */
  scope: Exclude<ReminderScope, "group">;
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
      const replay = await findReminderOperation(client, auth.familyId, input.operationKey, "create", inputHash);
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
             telegram_chat_id, message_thread_id, forum_topic_id, recurrence_unit, recurrence_interval,
            recurrence_anchor_local, recurrence_anchor_at, due_at, available_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::bigint, $11, $12,
                  $13::timestamptz AT TIME ZONE $7, $13, $13, $13)
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
          personal ? null : auth.forumTopicId,
          recurrence?.unit ?? null,
          recurrence?.interval ?? null,
          firstRunAt,
        ],
      );
      const reminder = inserted.rows[0]!;
      await recordReminderOperation(client, {
        familyId: auth.familyId,
        inputHash,
        operationKey: input.operationKey,
        operationKind: "create",
        reminderId: reminder.id,
      });
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

  async list(
    auth: ReminderAuthorization,
    options: { cursor?: string; limit: number },
  ): Promise<{ items: ReminderRecord[]; nextCursor: string | null }> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > REMINDER_LIST_MAX_LIMIT) {
      throw new AppError("AGENT_REMINDER_LIMIT_INVALID", "Некорректный размер страницы напоминаний");
    }
    const cursor = decodeDateUuidCursor(
      options.cursor,
      "AGENT_REMINDER_CURSOR_INVALID",
      "Не удалось продолжить просмотр напоминаний",
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
          AND ($3::timestamptz IS NULL OR (reminder.created_at, reminder.id) < ($3, $4::uuid))
        ORDER BY reminder.created_at DESC, reminder.id DESC
        LIMIT $5`,
      [auth.familyId, auth.userId, cursor?.timestamp ?? null, cursor?.id ?? null, options.limit + 1],
    );
    const hasNext = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(rowToReminder),
      nextCursor: hasNext && last ? encodeDateUuidCursor(last.created_at, last.id) : null,
    };
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
