/**
 * The one way a personal or family reminder row is written.
 *
 * Export:
 * - `ReminderInsert`: the destination, text and first run of a new reminder.
 * - `insertReminder`: writes the row, its replay record and its audit event in the caller's transaction.
 *
 * A reminder asked for now and a reminder that waited for its timezone (#451) are the same row, so
 * both go through here: the recurrence anchor is the first run read in the reminder's own zone.
 */
import type { PoolClient } from "pg";

import type { ReplyButtonRows } from "../reply-buttons/reply-button-contract.js";
import { recordReminderOperation } from "./reminder-mutation.js";
import type { ReminderRecurrence, ReminderRow } from "./reminder-record.js";
import { REMINDER_COLUMNS } from "./reminder-repository-helpers.js";

export interface ReminderInsert {
  authorUserId: string;
  buttons: ReplyButtonRows | null;
  content: string;
  familyId: string;
  firstRunAt: Date;
  forumTopicId: string | null;
  groupId: string | null;
  messageThreadId: string | null;
  ownerUserId: string | null;
  recurrence: ReminderRecurrence | null;
  scope: "family" | "personal";
  telegramChatId: string;
  timezone: string;
}

export async function insertReminder(
  client: PoolClient,
  row: ReminderInsert,
  operation: { inputHash: string; operationKey: string },
  auditMetadata: Readonly<Record<string, string>> = {},
): Promise<ReminderRow> {
  const inserted = await client.query<ReminderRow>(
    `INSERT INTO reminders
       (family_id, owner_user_id, author_user_id, group_id, scope, content, timezone,
        telegram_chat_id, message_thread_id, forum_topic_id, recurrence_unit, recurrence_interval,
        recurrence_anchor_local, recurrence_anchor_at, due_at, available_at, reply_buttons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::bigint, $11, $12,
             $13::timestamptz AT TIME ZONE $7, $13, $13, $13, $14::jsonb)
     RETURNING ${REMINDER_COLUMNS}`,
    [
      row.familyId,
      row.ownerUserId,
      row.authorUserId,
      row.groupId,
      row.scope,
      row.content,
      row.timezone,
      row.telegramChatId,
      row.messageThreadId,
      row.forumTopicId,
      row.recurrence?.unit ?? null,
      row.recurrence?.interval ?? null,
      row.firstRunAt,
      row.buttons === null ? null : JSON.stringify(row.buttons),
    ],
  );
  const reminder = inserted.rows[0]!;
  await recordReminderOperation(client, {
    familyId: row.familyId,
    inputHash: operation.inputHash,
    operationKey: operation.operationKey,
    operationKind: "create",
    reminderId: reminder.id,
  });
  await client.query(
    `INSERT INTO audit_events (family_id, actor_user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, 'reminder.created', $3,
             jsonb_build_object('scope', $4::text, 'recurrence', $5::text) || $6::jsonb)`,
    [row.familyId, row.authorUserId, reminder.id, row.scope, row.recurrence?.unit ?? "once", JSON.stringify(auditMetadata)],
  );
  return reminder;
}
