/**
 * Family task persistence and public contracts.
 *
 * Exports:
 * - Task scope/status/record/row types and row projection.
 */
export type TaskScope = "family" | "personal";
export type TaskStatus = "completed" | "open";

export interface TaskRecord {
  assigneeUserId: string;
  completedAt: string | null;
  createdAt: string;
  details: string | null;
  dueAt: string | null;
  id: string;
  scope: TaskScope;
  status: TaskStatus;
  timezone: string | null;
  title: string;
  updatedAt: string;
}

export interface TaskRow {
  assignee_user_id: string;
  completed_at: Date | null;
  created_at: Date;
  details: string | null;
  due_at: Date | null;
  id: string;
  scope: TaskScope;
  status: TaskStatus;
  timezone: string | null;
  title: string;
  updated_at: Date;
}

export function rowToTask(row: TaskRow): TaskRecord {
  return {
    assigneeUserId: row.assignee_user_id,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    details: row.details,
    dueAt: row.due_at?.toISOString() ?? null,
    id: row.id,
    scope: row.scope,
    status: row.status,
    timezone: row.timezone,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
  };
}
