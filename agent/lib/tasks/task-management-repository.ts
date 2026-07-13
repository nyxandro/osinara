/**
 * Family task edit and deletion boundary.
 *
 * Exports:
 * - `TaskUpdateInput`: complete replacement of editable task fields.
 * - `taskManagementRepository`: author-or-owner replay-safe update/delete operations.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { ReminderAuthorization } from "../reminders/reminder-context.js";
import { type TaskRecord, type TaskRow, rowToTask } from "./task-record.js";

const TASK_COLUMNS = `id, scope, assignee_user_id, title, details, due_at, timezone,
  status, completed_at, created_at, updated_at`;

export interface TaskUpdateInput {
  assigneeUserId?: string;
  details: string | null;
  dueAt: Date | null;
  operationKey: string;
  timezone: string | null;
  title: string;
}

interface MutableTaskRow extends TaskRow {
  author_user_id: string;
  overdue_lease_token: string | null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: string, maximum: number, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AppError(code, `Поле задачи должно содержать от 1 до ${maximum} символов`);
  }
  return normalized;
}

async function role(
  client: PoolClient,
  auth: ReminderAuthorization,
): Promise<"member" | "owner" | "recovery_owner"> {
  const result = await client.query<{ role: "member" | "owner" | "recovery_owner" }>(
    "SELECT role FROM family_memberships WHERE family_id = $1 AND user_id = $2",
    [auth.familyId, auth.userId],
  );
  if (!result.rows[0]) throw new AppError("AGENT_ACCESS_DENIED", "Нет доступа к этой семье");
  return result.rows[0].role;
}

async function task(
  client: PoolClient,
  familyId: string,
  id: string,
): Promise<MutableTaskRow | null> {
  const result = await client.query<MutableTaskRow>(
    `SELECT ${TASK_COLUMNS}, author_user_id, overdue_lease_token::text FROM family_tasks
     WHERE family_id = $1 AND id = $2 FOR UPDATE`,
    [familyId, id],
  );
  return result.rows[0] ?? null;
}

async function requireMutation(
  client: PoolClient,
  auth: ReminderAuthorization,
  row: MutableTaskRow,
): Promise<void> {
  const currentRole = await role(client, auth);
  if (row.author_user_id !== auth.userId && currentRole !== "owner") {
    throw new AppError(
      "AGENT_TASK_MUTATION_DENIED",
      "Изменить или удалить задачу может только её автор или владелец семьи",
    );
  }
}

async function replay(
  client: PoolClient,
  auth: ReminderAuthorization,
  operationKey: string,
  kind: "delete" | "update",
  inputHash: string,
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
  const operation = result.rows[0];
  if (!operation) return undefined;
  if (operation.operation_kind !== kind || operation.input_hash !== inputHash) {
    throw new AppError("AGENT_TASK_OPERATION_CONFLICT", "Повтор операции изменил параметры");
  }
  return operation.task_id;
}

export const taskManagementRepository = {
  async update(
    auth: ReminderAuthorization,
    id: string,
    input: TaskUpdateInput,
  ): Promise<TaskRecord> {
    const title = text(input.title, 300, "AGENT_TASK_TITLE_INVALID");
    const details = input.details === null
      ? null
      : text(input.details, 2_000, "AGENT_TASK_DETAILS_INVALID");
    if ((input.dueAt === null) !== (input.timezone === null)) {
      throw new AppError(
        "AGENT_TASK_TIME_INVALID",
        "Для срока одновременно укажите время и IANA timezone",
      );
    }
    const inputHash = hash({
      ...input,
      details,
      dueAt: input.dueAt?.toISOString() ?? null,
      title,
    });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const repeated = await replay(client, auth, input.operationKey, "update", inputHash);
      if (repeated) {
        const existing = await task(client, auth.familyId, repeated);
        if (!existing) throw new AppError("AGENT_TASK_NOT_FOUND", "Задача не найдена");
        await client.query("COMMIT");
        return rowToTask(existing);
      }
      const existing = await task(client, auth.familyId, id);
      if (!existing) throw new AppError("AGENT_TASK_NOT_FOUND", "Задача не найдена");
      await requireMutation(client, auth, existing);
      if (existing.overdue_lease_token) {
        throw new AppError(
          "AGENT_TASK_DELIVERY_IN_PROGRESS",
          "Уведомление о задаче сейчас отправляется. Повторите изменение позже",
        );
      }
      if (existing.status === "completed") {
        throw new AppError("AGENT_TASK_ALREADY_COMPLETED", "Завершённую задачу нельзя изменить");
      }
      const assigneeUserId = input.assigneeUserId ?? existing.assignee_user_id;
      const assignee = await client.query(
        "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2",
        [auth.familyId, assigneeUserId],
      );
      if (!assignee.rowCount) {
        throw new AppError("AGENT_TASK_ASSIGNEE_INVALID", "Исполнитель не состоит в этой семье");
      }
      if (existing.scope === "personal" && assigneeUserId !== existing.assignee_user_id) {
        throw new AppError("AGENT_TASK_ASSIGNEE_INVALID", "Личную задачу нельзя передать другому участнику");
      }
      if (input.dueAt) {
        const settings = await client.query<{ timezone: string }>(
          "SELECT timezone FROM user_notification_settings WHERE user_id = $1",
          [assigneeUserId],
        );
        if (settings.rows[0]?.timezone !== input.timezone) {
          throw new AppError(
            "AGENT_TASK_TIMEZONE_MISMATCH",
            "Timezone срока должен совпадать с настройкой исполнителя",
          );
        }
      }
      const scheduleChanged =
        assigneeUserId !== existing.assignee_user_id ||
        input.timezone !== existing.timezone ||
        input.dueAt?.getTime() !== existing.due_at?.getTime();
      const updated = await client.query<TaskRow>(
        `UPDATE family_tasks
         SET assignee_user_id = $2, title = $3, details = $4, due_at = $5,
             timezone = $6,
             overdue_available_at = CASE
               WHEN $7 AND scope = 'family' AND $5::timestamptz IS NOT NULL
                 THEN $5::timestamptz + interval '24 hours'
               WHEN $7 THEN NULL ELSE overdue_available_at END,
             overdue_notified_at = CASE WHEN $7 THEN NULL ELSE overdue_notified_at END,
             overdue_lease_token = CASE WHEN $7 THEN NULL ELSE overdue_lease_token END,
             overdue_lease_expires_at = CASE WHEN $7 THEN NULL ELSE overdue_lease_expires_at END,
             overdue_dispatch_started_at = CASE WHEN $7 THEN NULL ELSE overdue_dispatch_started_at END,
             overdue_error_code = CASE WHEN $7 THEN NULL ELSE overdue_error_code END,
             updated_at = now()
         WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
        [id, assigneeUserId, title, details, input.dueAt, input.timezone, scheduleChanged],
      );
      await client.query(
        `INSERT INTO family_task_operations
           (family_id, operation_key, operation_kind, input_hash, task_id)
         VALUES ($1, $2, 'update', $3, $4)`,
        [auth.familyId, input.operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'task.updated', $3, '{}'::jsonb)`,
        [auth.familyId, auth.userId, id],
      );
      await client.query("COMMIT");
      return rowToTask(updated.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async delete(auth: ReminderAuthorization, id: string, operationKey: string): Promise<boolean> {
    const inputHash = hash({ id });
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const repeated = await replay(client, auth, operationKey, "delete", inputHash);
      if (repeated !== undefined) {
        await client.query("COMMIT");
        return true;
      }
      const existing = await task(client, auth.familyId, id);
      if (!existing) throw new AppError("AGENT_TASK_NOT_FOUND", "Задача не найдена");
      await requireMutation(client, auth, existing);
      if (existing.overdue_lease_token) {
        throw new AppError(
          "AGENT_TASK_DELIVERY_IN_PROGRESS",
          "Уведомление о задаче сейчас отправляется. Повторите удаление позже",
        );
      }
      await client.query(
        `INSERT INTO family_task_operations
           (family_id, operation_key, operation_kind, input_hash, task_id)
         VALUES ($1, $2, 'delete', $3, $4)`,
        [auth.familyId, operationKey, inputHash, id],
      );
      await client.query(
        `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
         VALUES ($1, $2, 'task.deleted', $3, '{}'::jsonb)`,
        [auth.familyId, auth.userId, id],
      );
      await client.query("DELETE FROM family_tasks WHERE id = $1", [id]);
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
