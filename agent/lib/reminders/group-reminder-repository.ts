/**
 * PostgreSQL external-group reminder boundary.
 *
 * Exports:
 * - `GroupReminderCreateInput` and `GroupReminderUpdateInput`: validated mutation inputs.
 * - `groupReminderRepository`: replay-safe create/list/update/delete for a public chat.
 *
 * Key constructs:
 * - The reminder belongs to the chat: every participant may change and remove any of them, and the
 *   verified Telegram author is stored as provenance only, because a participant of an external
 *   group has no account here.
 * - Counting and inserting share one transaction under a per-group advisory lock, so two
 *   participants writing at the same moment cannot both pass the same free slot.
 * - Schedule math, lease policy and replay markers come from the shared mutation module, so a
 *   public-chat reminder behaves exactly like a trusted one everywhere except authorization.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { decodeDateUuidCursor, encodeDateUuidCursor, paginationFilterDigest } from "../keyset-pagination.js";
import { GROUP_REMINDER_TIMEZONE, REMINDER_LIST_MAX_LIMIT } from "./reminder-config.js";
import {
  GROUP_REMINDER_LIVE_STATUSES,
  requireFreeGroupSlot,
  requireGroupReminderDestination,
  requireGroupReminderOfThisChat,
  requireGroupReminderTime,
  reminderNotFound,
} from "./group-reminder-policy.js";
import type { GroupReminderAuthorization } from "./group-reminder-context.js";
import {
  applyReminderUpdate,
  recordReminderOperation,
  requireReminderNotLeased,
} from "./reminder-mutation.js";
import {
  type ReminderRecord,
  type ReminderRecurrence,
  type ReminderRow,
  reminderOperationHash,
  rowToReminder,
} from "./reminder-record.js";
import {
  REMINDER_COLUMNS,
  findReminderOperation,
  selectReminder,
} from "./reminder-repository-helpers.js";
import { requireReminderContent, requireReminderRecurrence } from "./reminder-validation.js";

export interface GroupReminderCreateInput {
  content: string;
  firstRunAt: Date;
  operationKey: string;
  recurrence: ReminderRecurrence | null;
}

export interface GroupReminderUpdateInput {
  content?: string;
  enabled?: boolean;
  firstRunAt?: Date;
  operationKey: string;
  recurrence?: ReminderRecurrence | null;
}

export const groupReminderRepository = {
  async create(
    auth: GroupReminderAuthorization,
    input: GroupReminderCreateInput,
  ): Promise<ReminderRecord> {
    const content = requireReminderContent(input.content);
    const firstRunAt = requireGroupReminderTime(input.firstRunAt);
    const recurrence = requireReminderRecurrence(input.recurrence);
    const inputHash = reminderOperationHash({
      ...input,
      content,
      firstRunAt: firstRunAt.toISOString(),
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(
        client,
        auth.familyId,
        input.operationKey,
        "create",
        inputHash,
      );
      if (replay !== undefined) {
        if (!replay) {
          throw new AppError(
            "AGENT_REMINDER_ALREADY_DELETED",
            "Это напоминание уже было создано и затем удалено",
          );
        }
        const existing = await selectReminder(client, auth.familyId, replay);
        if (!existing) throw reminderNotFound();
        // A replayed marker still has to point at this chat: the family owns more than one, and a
        // marker is keyed only by family and operation key.
        requireGroupReminderOfThisChat(auth, existing);
        await client.query("COMMIT");
        return rowToReminder(existing);
      }

      // Destination is accepted only from the live registration of the verified current chat.
      await requireGroupReminderDestination(client, auth);
      await requireFreeGroupSlot(client, auth, null);
      const inserted = await client.query<ReminderRow>(
        `INSERT INTO reminders
           (family_id, author_telegram_user_id, group_id, scope, content, timezone,
            telegram_chat_id, recurrence_unit, recurrence_interval,
            recurrence_anchor_local, recurrence_anchor_at, due_at, available_at)
         VALUES ($1, $2, $3, 'group', $4, $5, $6, $7, $8,
                 $9::timestamptz AT TIME ZONE $5, $9, $9, $9)
         RETURNING ${REMINDER_COLUMNS}`,
        [
          auth.familyId,
          auth.telegramUserId,
          auth.groupId,
          content,
          GROUP_REMINDER_TIMEZONE,
          auth.telegramChatId,
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
         VALUES ($1, NULL, 'reminder.created', $2,
                 jsonb_build_object('scope', 'group', 'groupId', $3::text,
                                    'telegramUserId', $4::text, 'recurrence', $5::text))`,
        [auth.familyId, reminder.id, auth.groupId, auth.telegramUserId, recurrence?.unit ?? "once"],
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

  /** Every record of the chat is visible to every participant, paused ones included. */
  async list(
    auth: GroupReminderAuthorization,
    options: { cursor?: string; limit: number },
  ): Promise<{ items: ReminderRecord[]; nextCursor: string | null }> {
    if (
      !Number.isInteger(options.limit) || options.limit < 1 ||
      options.limit > REMINDER_LIST_MAX_LIMIT
    ) {
      throw new AppError("AGENT_REMINDER_LIMIT_INVALID", "Некорректный размер страницы напоминаний");
    }
    const binding = paginationFilterDigest([auth.groupId]);
    const cursor = decodeDateUuidCursor(
      options.cursor,
      "AGENT_REMINDER_CURSOR_INVALID",
      "Не удалось продолжить просмотр напоминаний",
      binding,
    );
    const result = await database().query<ReminderRow>(
      `SELECT ${REMINDER_COLUMNS}
       FROM reminders AS reminder
       WHERE reminder.scope = 'group' AND reminder.group_id = $1
         AND reminder.status IN ${GROUP_REMINDER_LIVE_STATUSES}
         AND ($2::timestamptz IS NULL OR (reminder.due_at, reminder.id) > ($2, $3::uuid))
       ORDER BY reminder.due_at, reminder.id
       LIMIT $4`,
      [auth.groupId, cursor?.timestamp ?? null, cursor?.id ?? null, options.limit + 1],
    );
    const hasNext = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(rowToReminder),
      nextCursor: hasNext && last ? encodeDateUuidCursor(last.due_at, last.id, binding) : null,
    };
  },

  async update(
    auth: GroupReminderAuthorization,
    id: string,
    input: GroupReminderUpdateInput,
  ): Promise<ReminderRecord> {
    if (
      input.content === undefined && input.enabled === undefined &&
      input.firstRunAt === undefined && input.recurrence === undefined
    ) {
      throw new AppError("AGENT_REMINDER_UPDATE_INVALID", "Не указаны изменения напоминания");
    }
    const content = input.content === undefined ? undefined : requireReminderContent(input.content);
    const firstRunAt = input.firstRunAt === undefined
      ? undefined
      : requireGroupReminderTime(input.firstRunAt);
    const recurrence = input.recurrence === undefined
      ? undefined
      : requireReminderRecurrence(input.recurrence);
    const inputHash = reminderOperationHash({
      ...input,
      content,
      firstRunAt: firstRunAt?.toISOString(),
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(
        client,
        auth.familyId,
        input.operationKey,
        "update",
        inputHash,
      );
      if (replay) {
        const existing = await selectReminder(client, auth.familyId, replay);
        if (!existing) throw reminderNotFound();
        requireGroupReminderOfThisChat(auth, existing);
        await client.query("COMMIT");
        return rowToReminder(existing);
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw reminderNotFound();
      requireGroupReminderOfThisChat(auth, reminder);
      const live = reminder.status === "active" || reminder.status === "leased" ||
        reminder.status === "paused";
      if (input.enabled === false && !live) {
        throw new AppError(
          "AGENT_REMINDER_NOT_ACTIVE",
          "Приостановить можно только действующее напоминание",
        );
      }
      // Reviving a completed or failed reminder puts it back among the live ones, so it has to pass
      // the same caps as a new one. Without this, a failed batch would launder extra slots.
      if (input.enabled === true && !live) await requireFreeGroupSlot(client, auth, id);
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
         VALUES ($1, NULL, 'reminder.updated', $2,
                 jsonb_build_object('scope', 'group', 'telegramUserId', $3::text))`,
        [auth.familyId, id, auth.telegramUserId],
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

  /** Any participant of the chat may remove any of its reminders, except one already in flight. */
  async delete(
    auth: GroupReminderAuthorization,
    id: string,
    operationKey: string,
  ): Promise<boolean> {
    const inputHash = reminderOperationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const replay = await findReminderOperation(
        client,
        auth.familyId,
        operationKey,
        "delete",
        inputHash,
      );
      if (replay !== undefined) {
        // A completed deletion leaves the marker without a row, so the repeat is simply confirmed.
        // A marker that still points at a record is only honoured for a record of this chat.
        if (replay !== null) {
          const existing = await selectReminder(client, auth.familyId, replay);
          if (!existing) throw reminderNotFound();
          requireGroupReminderOfThisChat(auth, existing);
        }
        await client.query("COMMIT");
        return true;
      }
      const reminder = await selectReminder(client, auth.familyId, id, true);
      if (!reminder) throw reminderNotFound();
      requireGroupReminderOfThisChat(auth, reminder);
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
         VALUES ($1, NULL, 'reminder.deleted', $2,
                 jsonb_build_object('scope', 'group', 'telegramUserId', $3::text,
                                    'authorTelegramUserId', $4::text))`,
        [auth.familyId, id, auth.telegramUserId, reminder.author_telegram_user_id],
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
