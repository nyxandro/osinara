/**
 * Scoped PostgreSQL family task repository.
 *
 * Exports:
 * - `TaskCreateInput`: explicit destination, assignee, due time, and timezone.
 * - `taskRepository`: replay-safe create/list/complete task operations.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { ReminderAuthorization } from "../reminders/reminder-context.js";
import { type TaskRecord, type TaskRow, type TaskScope, rowToTask } from "./task-record.js";

const TASK_DETAILS_MAX_LENGTH = 2_000;
const TASK_LIST_LIMIT = 100;
const TASK_TITLE_MAX_LENGTH = 300;
const TASK_COLUMNS = `id, scope, assignee_user_id, title, details, due_at, timezone,
  status, completed_at, created_at, updated_at`;

export interface TaskCreateInput {
  assigneeUserId: string;
  details: string | null;
  dueAt: Date | null;
  operationKey: string;
  scope: TaskScope;
  timezone: string | null;
  title: string;
}

interface MutableTaskRow extends TaskRow {
  author_user_id: string;
  family_id: string;
  overdue_dispatch_started_at: Date | null;
}

function operationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedText(value: string, maximum: number, code: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AppError(code, `${label} должен содержать от 1 до ${maximum} символов`);
  }
  return normalized;
}

function normalizedDetails(value: string | null): string | null {
  if (value === null) return null;
  return normalizedText(value, TASK_DETAILS_MAX_LENGTH, "AGENT_TASK_DETAILS_INVALID", "Описание");
}

async function requireMembership(
  client: PoolClient,
  auth: ReminderAuthorization,
): Promise<"member" | "owner" | "recovery_owner"> {
  const result = await client.query<{ role: "member" | "owner" | "recovery_owner" }>(
    "SELECT role FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  const role = result.rows[0]?.role;
  if (!role) throw new AppError("AGENT_ACCESS_DENIED", "У вас больше нет доступа к этой семье");
  return role;
}

async function findReplay(
  client: PoolClient,
  auth: ReminderAuthorization,
  operationKey: string,
  kind: "complete" | "create" | "delete" | "update",
  hash: string,
): Promise<string | null | undefined> {
  const result = await client.query<{
    input_hash: string;
    operation_kind: string;
    task_id: string | null;
  }>(
    `SELECT operation_kind, input_hash, task_id FROM family_task_operations
     WHERE family_id = $1 AND operation_key = $2`,
    [auth.familyId, operationKey],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.operation_kind !== kind || row.input_hash !== hash) {
    throw new AppError("AGENT_TASK_OPERATION_CONFLICT", "Повтор операции задачи изменил параметры");
  }
  return row.task_id;
}

async function selectTask(
  client: PoolClient,
  familyId: string,
  id: string,
  lock = false,
): Promise<MutableTaskRow | null> {
  const result = await client.query<MutableTaskRow>(
    `SELECT ${TASK_COLUMNS}, family_id, author_user_id, overdue_dispatch_started_at FROM family_tasks
     WHERE family_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [familyId, id],
  );
  return result.rows[0] ?? null;
}

export const taskRepository = {
  async listMembers(auth: ReminderAuthorization): Promise<Array<{
    displayName: string;
    role: "member" | "owner" | "recovery_owner";
    userId: string;
  }>> {
    const result = await database().query<{
      display_name: string;
      role: "member" | "owner" | "recovery_owner";
      user_id: string;
    }>(
      `SELECT users.id AS user_id, users.display_name, membership.role
       FROM family_memberships AS membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.family_id = $1
         AND EXISTS (
           SELECT 1 FROM family_memberships
           WHERE family_id = $1 AND user_id = $2
         )
       ORDER BY users.display_name, users.id`,
      [auth.familyId, auth.userId],
    );
    return result.rows.map((row) => ({
      displayName: row.display_name,
      role: row.role,
      userId: row.user_id,
    }));
  },

  async create(auth: ReminderAuthorization, input: TaskCreateInput): Promise<TaskRecord> {
    const title = normalizedText(
      input.title,
      TASK_TITLE_MAX_LENGTH,
      "AGENT_TASK_TITLE_INVALID",
      "Название задачи",
    );
    const details = normalizedDetails(input.details);
    if ((input.dueAt === null) !== (input.timezone === null)) {
      throw new AppError(
        "AGENT_TASK_TIME_INVALID",
        "Для срока задачи одновременно укажите точное время и IANA timezone",
      );
    }
    if (input.dueAt && Number.isNaN(input.dueAt.getTime())) {
      throw new AppError("AGENT_TASK_TIME_INVALID", "Укажите корректный срок задачи");
    }
    const hash = operationHash({
      ...input,
      details,
      dueAt: input.dueAt?.toISOString() ?? null,
      title,
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await requireMembership(client, auth);
      const replay = await findReplay(client, auth, input.operationKey, "create", hash);
      if (replay !== undefined) {
        if (!replay) throw new AppError("AGENT_TASK_NOT_FOUND", "Задача уже была удалена");
        const existing = await selectTask(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_TASK_NOT_FOUND", "Задача уже была удалена");
        await client.query("COMMIT");
        return rowToTask(existing);
      }

      const assignee = await client.query(
        "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2",
        [auth.familyId, input.assigneeUserId],
      );
      if (!assignee.rowCount) {
        throw new AppError("AGENT_TASK_ASSIGNEE_INVALID", "Исполнитель не состоит в этой семье");
      }
      const personal = input.scope === "personal";
      if (personal && (auth.telegramChatType !== "private" || input.assigneeUserId !== auth.userId)) {
        throw new AppError(
          "AGENT_TASK_DESTINATION_INVALID",
          "Личную задачу можно создать только себе в личном чате",
        );
      }
      if (!personal && (auth.groupType !== "family_private" || !auth.groupId)) {
        throw new AppError(
          "AGENT_TASK_DESTINATION_INVALID",
          "Семейную задачу создавайте в зарегистрированной семейной группе",
        );
      }
      if (!personal) {
        const group = await client.query(
          `SELECT 1 FROM telegram_groups
           WHERE id = $1 AND family_id = $2 AND telegram_chat_id = $3 AND type = 'family_private'`,
          [auth.groupId, auth.familyId, auth.telegramChatId],
        );
        if (!group.rowCount) {
          throw new AppError("AGENT_TASK_DESTINATION_INVALID", "Семейная группа не зарегистрирована");
        }
      }
      if (input.dueAt) {
        const settings = await client.query<{ timezone: string }>(
          "SELECT timezone FROM user_notification_settings WHERE user_id = $1",
          [input.assigneeUserId],
        );
        if (!settings.rows[0]) {
          throw new AppError(
            "AGENT_NOTIFICATION_SETTINGS_REQUIRED",
            "Исполнителю нужно сначала настроить timezone уведомлений",
          );
        }
        if (settings.rows[0].timezone !== input.timezone) {
          throw new AppError(
            "AGENT_TASK_TIMEZONE_MISMATCH",
            `Подтвердите срок в timezone исполнителя ${settings.rows[0].timezone}`,
          );
        }
      }
      const inserted = await client.query<TaskRow>(
        `INSERT INTO family_tasks
           (family_id, author_user_id, assignee_user_id, owner_user_id, group_id, scope,
            title, details, due_at, timezone, telegram_chat_id, message_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint)
         RETURNING ${TASK_COLUMNS}`,
        [
          auth.familyId,
          auth.userId,
          input.assigneeUserId,
          personal ? auth.userId : null,
          personal ? null : auth.groupId,
          input.scope,
          title,
          details,
          input.dueAt,
          input.timezone,
          personal ? null : auth.telegramChatId,
          personal ? null : auth.messageThreadId,
        ],
      );
      const task = inserted.rows[0]!;
      if (!personal && input.dueAt) {
        await client.query(
          `UPDATE family_tasks
           SET overdue_available_at = due_at + interval '24 hours'
           WHERE id = $1`,
          [task.id],
        );
      }
      await client.query(
        `INSERT INTO family_task_operations
           (family_id, operation_key, operation_kind, input_hash, task_id)
         VALUES ($1, $2, 'create', $3, $4)`,
        [auth.familyId, input.operationKey, hash, task.id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'task.created', $3, jsonb_build_object('scope', $4::text))`,
        [auth.familyId, auth.userId, task.id, input.scope],
      );
      await client.query("COMMIT");
      return rowToTask(task);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async list(auth: ReminderAuthorization): Promise<TaskRecord[]> {
    const result = await database().query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM family_tasks AS task
       WHERE task.family_id = $1
         AND EXISTS (
           SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2
         )
         AND ((task.scope = 'personal' AND task.owner_user_id = $2) OR task.scope = 'family')
       ORDER BY task.status, task.due_at NULLS LAST, task.created_at DESC
       LIMIT $3`,
      [auth.familyId, auth.userId, TASK_LIST_LIMIT],
    );
    return result.rows.map(rowToTask);
  },

  async complete(
    auth: ReminderAuthorization,
    id: string,
    operationKey: string,
  ): Promise<TaskRecord> {
    const hash = operationHash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const role = await requireMembership(client, auth);
      const replay = await findReplay(client, auth, operationKey, "complete", hash);
      if (replay) {
        const existing = await selectTask(client, auth.familyId, replay);
        if (!existing) throw new AppError("AGENT_TASK_NOT_FOUND", "Задача не найдена");
        await client.query("COMMIT");
        return rowToTask(existing);
      }
      const task = await selectTask(client, auth.familyId, id, true);
      if (!task) throw new AppError("AGENT_TASK_NOT_FOUND", "Задача не найдена");
      const allowed = task.scope === "personal"
        ? task.assignee_user_id === auth.userId
        : task.assignee_user_id === auth.userId || task.author_user_id === auth.userId || role === "owner";
      if (!allowed) {
        throw new AppError(
          "AGENT_TASK_COMPLETION_DENIED",
          "Завершить задачу может исполнитель, автор или владелец семьи",
        );
      }
      if (task.overdue_dispatch_started_at) {
        throw new AppError(
          "AGENT_TASK_DELIVERY_IN_PROGRESS",
          "Уведомление о просрочке сейчас отправляется. Повторите завершение позже",
        );
      }
      const completed = task.status === "completed"
        ? task
        : (await client.query<TaskRow>(
            `UPDATE family_tasks
             SET status = 'completed', completed_by_user_id = $2, completed_at = now(),
                 overdue_lease_token = NULL, overdue_lease_expires_at = NULL,
                 overdue_dispatch_started_at = NULL, overdue_error_code = NULL, updated_at = now()
             WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
            [id, auth.userId],
          )).rows[0]!;
      await client.query(
        `INSERT INTO family_task_operations
           (family_id, operation_key, operation_kind, input_hash, task_id)
         VALUES ($1, $2, 'complete', $3, $4)`,
        [auth.familyId, operationKey, hash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'task.completed', $3, '{}'::jsonb)`,
        [auth.familyId, auth.userId, id],
      );
      await client.query("COMMIT");
      return rowToTask(completed);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
