/**
 * Reminder persistence and public record contracts.
 *
 * Exports:
 * - Reminder scope, status, recurrence, row, and public record types.
 * - `reminderOperationHash`: replay-protection fingerprint.
 * - `rowToReminder`: safe PostgreSQL projection.
 */
import { createHash } from "node:crypto";

export type ReminderScope = "family" | "personal";
export type ReminderStatus = "active" | "completed" | "failed" | "leased" | "paused";
export type ReminderRecurrenceUnit = "daily" | "monthly" | "weekly";

export interface ReminderRecurrence {
  interval: number;
  unit: ReminderRecurrenceUnit;
}

export interface ReminderRecord {
  content: string;
  createdAt: string;
  id: string;
  lastErrorCode: string | null;
  messageThreadId: string | null;
  nextRunAt: string;
  recurrence: ReminderRecurrence | null;
  scope: ReminderScope;
  status: ReminderStatus;
  timezone: string;
  updatedAt: string;
}

export interface ReminderRow {
  content: string;
  created_at: Date;
  due_at: Date;
  id: string;
  last_error_code: string | null;
  message_thread_id: string | null;
  recurrence_interval: number | null;
  recurrence_unit: ReminderRecurrenceUnit | null;
  scope: ReminderScope;
  status: ReminderStatus;
  timezone: string;
  updated_at: Date;
}

export function rowToReminder(row: ReminderRow): ReminderRecord {
  return {
    content: row.content,
    createdAt: row.created_at.toISOString(),
    id: row.id,
    lastErrorCode: row.last_error_code,
    messageThreadId: row.message_thread_id,
    nextRunAt: row.due_at.toISOString(),
    recurrence: row.recurrence_unit && row.recurrence_interval
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    scope: row.scope,
    status: row.status,
    timezone: row.timezone,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function reminderOperationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
