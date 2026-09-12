/**
 * Reminder mutation shared by the trusted and external-group boundaries.
 *
 * Exports:
 * - `ReminderMutationValues`: validated optional changes of one reminder.
 * - `requireReminderNotLeased`: refuses a change while Telegram delivery is in flight.
 * - `applyReminderUpdate`: recomputes schedule state and writes the row.
 * - `recordReminderOperation`: writes the replay marker of one mutation.
 *
 * Key construct:
 * - Recurrence math and lease policy stay in one place, so a group reminder cannot drift away from
 *   the behavior a personal or family reminder already has. Only authorization differs per scope,
 *   and each repository proves it before calling in here.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import type { MutableReminderRow } from "./reminder-repository-helpers.js";
import { REMINDER_COLUMNS } from "./reminder-repository-helpers.js";
import type { ReminderRecurrence, ReminderRow, ReminderStatus } from "./reminder-record.js";

export interface ReminderMutationValues {
  content?: string;
  enabled?: boolean;
  firstRunAt?: Date;
  recurrence?: ReminderRecurrence | null;
}

const LEASED_MESSAGES = {
  delete: "Напоминание сейчас отправляется. Повторите удаление после завершения доставки",
  update: "Напоминание сейчас отправляется. Повторите изменение после завершения доставки",
} as const;

export function requireReminderNotLeased(
  reminder: { status: ReminderStatus },
  action: keyof typeof LEASED_MESSAGES,
): void {
  if (reminder.status === "leased") {
    throw new AppError("AGENT_REMINDER_DELIVERY_IN_PROGRESS", LEASED_MESSAGES[action]);
  }
}

export async function applyReminderUpdate(
  client: PoolClient,
  reminder: MutableReminderRow,
  values: ReminderMutationValues,
): Promise<ReminderRow> {
  requireReminderNotLeased(reminder, "update");
  if (values.enabled === true && reminder.status === "completed" && !values.firstRunAt) {
    throw new AppError(
      "AGENT_REMINDER_TIME_REQUIRED",
      "Для повторного запуска завершённого напоминания укажите новое время",
    );
  }
  const scheduleChanged = values.firstRunAt !== undefined || values.recurrence !== undefined;
  const nextDue = values.firstRunAt ?? reminder.due_at;
  const nextRecurrence = values.recurrence === undefined
    ? reminder.recurrence_unit && reminder.recurrence_interval
      ? { interval: reminder.recurrence_interval, unit: reminder.recurrence_unit }
      : null
    : values.recurrence;
  const updated = await client.query<ReminderRow>(
    `UPDATE reminders
     SET content = $2,
         recurrence_unit = $3, recurrence_interval = $4,
          recurrence_anchor_local = CASE WHEN $5 THEN $6::timestamptz AT TIME ZONE timezone ELSE recurrence_anchor_local END,
          recurrence_anchor_at = CASE WHEN $5 THEN $6::timestamptz ELSE recurrence_anchor_at END,
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
      reminder.id,
      values.content ?? reminder.content,
      nextRecurrence?.unit ?? null,
      nextRecurrence?.interval ?? null,
      scheduleChanged,
      nextDue,
      values.enabled ?? null,
    ],
  );
  return updated.rows[0]!;
}

export async function recordReminderOperation(
  client: PoolClient,
  input: {
    familyId: string;
    inputHash: string;
    operationKey: string;
    operationKind: "create" | "delete" | "update";
    reminderId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO reminder_operations
       (family_id, operation_key, operation_kind, input_hash, reminder_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.familyId, input.operationKey, input.operationKind, input.inputHash, input.reminderId],
  );
}
