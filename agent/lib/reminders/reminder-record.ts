/**
 * Reminder persistence and public record contracts.
 *
 * Exports:
 * - Reminder scope, status, recurrence, row, and public record types.
 * - `reminderOperationHash`: replay-protection fingerprint.
 * - `rowToReminder`: safe PostgreSQL projection.
 *
 * A reminder's buttons are shown to the model the way it writes them, as markup at the end of the
 * content, so content it passes back unchanged keeps them.
 */
import { createHash } from "node:crypto";

import type { ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { replyButtonMarkup } from "../reply-buttons/reply-button-markup.js";

export type ReminderScope = "family" | "group" | "personal";
export type ReminderStatus = "active" | "completed" | "failed" | "leased" | "paused";
export const REMINDER_RECURRENCE_UNITS = ["daily", "weekly", "monthly", "minutely", "hourly", "yearly"] as const;
export type ReminderRecurrenceUnit = (typeof REMINDER_RECURRENCE_UNITS)[number];

export interface ReminderRecurrence {
  interval: number;
  unit: ReminderRecurrenceUnit;
}

export interface ReminderRecord {
  /** The text, followed by the markup of the reply buttons sent with every delivery. */
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
  forum_topic_id: string | null;
  id: string;
  last_error_code: string | null;
  message_thread_id: string | null;
  recurrence_interval: number | null;
  recurrence_unit: ReminderRecurrenceUnit | null;
  reply_buttons: ReplyButtonRows | null;
  scope: ReminderScope;
  status: ReminderStatus;
  timezone: string;
  updated_at: Date;
}

export function rowToReminder(row: ReminderRow): ReminderRecord {
  return {
    content: row.reply_buttons === null ? row.content : `${row.content}\n\n${replyButtonMarkup(row.reply_buttons)}`,
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
