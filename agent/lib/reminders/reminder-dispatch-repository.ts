/**
 * Durable reminder dispatch queue boundary.
 *
 * Exports:
 * - `ClaimedReminder`: leased, authorization-revalidated Telegram delivery.
 * - `reminderDispatchRepository`: claim, side-effect marker, completion, and terminal failure.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  type ProactiveDeliveryReceipt,
  recordProactiveDelivery,
} from "../proactive-deliveries/proactive-delivery-repository.js";
import {
  REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS,
  REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS,
  REMINDER_RECURRENCE_MAX_SKIPPED_OCCURRENCES,
} from "./reminder-config.js";
import type { ReminderRecurrenceUnit, ReminderScope } from "./reminder-record.js";

export interface ClaimedReminder {
  content: string;
  delayed: boolean;
  dueAt: string;
  familyId: string;
  groupId: string | null;
  id: string;
  leaseToken: string;
  messageThreadId: string | null;
  ownerUserId: string | null;
  scope: ReminderScope;
  telegramChatId: string;
  timezone: string;
}

interface ClaimOptions {
  leaseMilliseconds: number;
  limit: number;
  now: Date;
}

interface ClaimedRow {
  content: string;
  delayed: boolean;
  due_at: Date;
  family_id: string;
  group_id: string | null;
  id: string;
  lease_token: string;
  message_thread_id: string | null;
  owner_user_id: string | null;
  scope: ReminderScope;
  telegram_chat_id: string;
  timezone: string;
}

interface RecurrenceRow {
  family_id: string;
  next_due_at: Date;
  next_index: number;
}

function requireClaimOptions(options: ClaimOptions): void {
  if (
    !(options.now instanceof Date) ||
    Number.isNaN(options.now.getTime()) ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    !Number.isInteger(options.leaseMilliseconds) ||
    options.leaseMilliseconds < 1
  ) {
    throw new AppError(
      "AGENT_REMINDER_CLAIM_INVALID",
      "Диспетчер получил некорректные параметры напоминаний",
    );
  }
}

async function recordFailures(
  client: PoolClient,
  rows: readonly { family_id: string; id: string }[],
  errorCode: string,
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
       VALUES ($1, 'reminder.delivery_failed', $2, jsonb_build_object('code', $3::text))`,
      [row.family_id, row.id, errorCode],
    );
  }
}

export const reminderDispatchRepository = {
  async claimDue(options: ClaimOptions): Promise<ClaimedReminder[]> {
    requireClaimOptions(options);
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Once Telegram dispatch starts, an expired lease is ambiguous and must never auto-repeat.
      const ambiguous = await client.query<{ family_id: string; id: string }>(
        `UPDATE reminders
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             dispatch_started_at = NULL,
             last_error_code = 'AGENT_REMINDER_DELIVERY_AMBIGUOUS', updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NOT NULL
         RETURNING id, family_id`,
        [options.now],
      );
      await recordFailures(client, ambiguous.rows, "AGENT_REMINDER_DELIVERY_AMBIGUOUS");

      // A crash before the side-effect marker is safe to recover, but retries remain explicitly bounded.
      const exhausted = await client.query<{ family_id: string; id: string }>(
        `UPDATE reminders
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'AGENT_REMINDER_DELIVERY_ATTEMPTS_EXHAUSTED', updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
           AND attempts >= $2
         RETURNING id, family_id`,
        [options.now, REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS],
      );
      await recordFailures(client, exhausted.rows, "AGENT_REMINDER_DELIVERY_ATTEMPTS_EXHAUSTED");
      await client.query(
        `UPDATE reminders
         SET status = 'active', lease_token = NULL, lease_expires_at = NULL, updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
           AND attempts < $2`,
        [options.now, REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS],
      );

      // Removed memberships or changed trust zones invalidate a proactive destination fail-closed.
      const invalid = await client.query<{ family_id: string; id: string }>(
        `UPDATE reminders AS reminder
         SET status = 'failed', last_error_code = 'AGENT_REMINDER_DESTINATION_REVOKED',
             updated_at = $1
         WHERE reminder.status = 'active' AND (
            NOT EXISTS (
              SELECT 1 FROM family_memberships
              WHERE family_id = reminder.family_id AND user_id = reminder.author_user_id
            ) OR (
              reminder.scope = 'family' AND NOT EXISTS (
                SELECT 1 FROM telegram_groups AS group_row
                WHERE group_row.id = reminder.group_id AND group_row.family_id = reminder.family_id
                  AND group_row.telegram_chat_id = reminder.telegram_chat_id
                  AND group_row.type = 'family_private'
              )
            )
          )
         RETURNING reminder.id, reminder.family_id`,
        [options.now],
      );
      await recordFailures(client, invalid.rows, "AGENT_REMINDER_DESTINATION_REVOKED");

      // Quiet hours defer availability while retaining the original due_at for delayed-delivery notice.
      await client.query(
        `UPDATE reminders AS reminder
         SET available_at = (
               (($1 AT TIME ZONE settings.timezone)::date + settings.quiet_end) +
               make_interval(days => CASE
                 WHEN settings.quiet_start > settings.quiet_end
                   AND ($1 AT TIME ZONE settings.timezone)::time >= settings.quiet_start
                 THEN 1 ELSE 0 END)
             ) AT TIME ZONE settings.timezone,
             delayed_by_quiet_hours = true,
             updated_at = $1
         FROM user_notification_settings AS settings
         WHERE reminder.status = 'active' AND reminder.author_user_id = settings.user_id
           AND reminder.available_at <= $1
           AND settings.quiet_start IS NOT NULL AND settings.quiet_end IS NOT NULL
           AND (
             (settings.quiet_start < settings.quiet_end
               AND ($1 AT TIME ZONE settings.timezone)::time >= settings.quiet_start
               AND ($1 AT TIME ZONE settings.timezone)::time < settings.quiet_end) OR
             (settings.quiet_start > settings.quiet_end
               AND (($1 AT TIME ZONE settings.timezone)::time >= settings.quiet_start
                 OR ($1 AT TIME ZONE settings.timezone)::time < settings.quiet_end))
           )`,
        [options.now],
      );

      const claimed = await client.query<ClaimedRow>(
        `WITH candidates AS (
           SELECT reminder.id
           FROM reminders AS reminder
           JOIN family_memberships AS membership
             ON membership.family_id = reminder.family_id AND membership.user_id = reminder.author_user_id
           WHERE reminder.status = 'active' AND reminder.available_at <= $1
             AND reminder.attempts < $4
           ORDER BY reminder.available_at, reminder.id
           FOR UPDATE OF reminder SKIP LOCKED
           LIMIT $2
         )
         UPDATE reminders AS reminder
         SET status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
             lease_expires_at = $1 + ($3::text || ' milliseconds')::interval,
             dispatch_started_at = NULL, updated_at = $1
         FROM candidates
         WHERE reminder.id = candidates.id
         RETURNING reminder.id, reminder.family_id, reminder.owner_user_id, reminder.group_id,
                   reminder.content, reminder.scope, reminder.timezone, reminder.telegram_chat_id,
                   reminder.message_thread_id::text, reminder.due_at, reminder.lease_token::text,
                   (reminder.delayed_by_quiet_hours OR reminder.due_at < $1 - ($5::text || ' milliseconds')::interval) AS delayed`,
        [
          options.now,
          options.limit,
          options.leaseMilliseconds,
          REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS,
          REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS,
        ],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        content: row.content,
        delayed: row.delayed,
        dueAt: row.due_at.toISOString(),
        familyId: row.family_id,
        groupId: row.group_id,
        id: row.id,
        leaseToken: row.lease_token,
        messageThreadId: row.message_thread_id,
        ownerUserId: row.owner_user_id,
        scope: row.scope,
        telegramChatId: row.telegram_chat_id,
        timezone: row.timezone,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markDispatchStarted(id: string, leaseToken: string): Promise<void> {
    const result = await database().query(
      `UPDATE reminders SET dispatch_started_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2
         AND dispatch_started_at IS NULL`,
      [id, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_REMINDER_LEASE_STALE",
        "Доставка напоминания уже неактуальна",
      );
    }
  },

  async complete(
    job: ClaimedReminder,
    completedAt: Date,
    receipt: ProactiveDeliveryReceipt,
  ): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const reminder = await client.query<{
        family_id: string;
        recurrence_unit: ReminderRecurrenceUnit | null;
      }>(
        `SELECT family_id, recurrence_unit FROM reminders
         WHERE id = $1 AND status = 'leased' AND lease_token = $2
           AND dispatch_started_at IS NOT NULL
         FOR UPDATE`,
        [job.id, job.leaseToken],
      );
      const current = reminder.rows[0];
      if (!current) {
        throw new AppError("AGENT_REMINDER_LEASE_STALE", "Доставка напоминания уже неактуальна");
      }

      // The journal row and reminder state commit together after Telegram confirms the message id.
      await recordProactiveDelivery(client, {
        content: receipt.text,
        deliveredAt: completedAt,
        familyId: job.familyId,
        groupId: job.groupId,
        messageThreadId: job.messageThreadId,
        ownerUserId: job.ownerUserId,
        scheduledFor: new Date(job.dueAt),
        scope: job.scope,
        sourceId: job.id,
        sourceKind: "reminder",
        telegramChatId: job.telegramChatId,
        telegramMessageId: receipt.messageId,
        title: null,
      });

      if (current.recurrence_unit === null) {
        await client.query(
          `UPDATE reminders
           SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
               dispatch_started_at = NULL, delayed_by_quiet_hours = false,
               last_error_code = NULL, updated_at = $2
           WHERE id = $1`,
          [job.id, completedAt],
        );
      } else {
        // Recompute from the original local anchor, skipping missed occurrences without replaying them.
        const recurrence = await client.query<RecurrenceRow>(
          `WITH RECURSIVE occurrences AS (
             SELECT reminder.family_id, reminder.occurrence_index + 1 AS next_index,
                    CASE reminder.recurrence_unit
                      WHEN 'daily' THEN (reminder.recurrence_anchor_local + make_interval(days => reminder.recurrence_interval * (reminder.occurrence_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'weekly' THEN (reminder.recurrence_anchor_local + make_interval(days => 7 * reminder.recurrence_interval * (reminder.occurrence_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'monthly' THEN (reminder.recurrence_anchor_local + make_interval(months => reminder.recurrence_interval * (reminder.occurrence_index + 1))) AT TIME ZONE reminder.timezone
                     END AS next_due_at,
                    reminder.occurrence_index AS initial_index
             FROM reminders AS reminder WHERE reminder.id = $1
             UNION ALL
             SELECT occurrence.family_id, occurrence.next_index + 1,
                    CASE reminder.recurrence_unit
                      WHEN 'daily' THEN (reminder.recurrence_anchor_local + make_interval(days => reminder.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'weekly' THEN (reminder.recurrence_anchor_local + make_interval(days => 7 * reminder.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE reminder.timezone
                      WHEN 'monthly' THEN (reminder.recurrence_anchor_local + make_interval(months => reminder.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE reminder.timezone
                     END,
                    occurrence.initial_index
             FROM occurrences AS occurrence
             JOIN reminders AS reminder ON reminder.id = $1
             WHERE occurrence.next_due_at <= $2
               AND occurrence.next_index - occurrence.initial_index < $3
           )
           SELECT family_id, next_index, next_due_at
           FROM occurrences WHERE next_due_at > $2
           ORDER BY next_index LIMIT 1`,
          [job.id, completedAt, REMINDER_RECURRENCE_MAX_SKIPPED_OCCURRENCES],
        );
        const next = recurrence.rows[0];
        if (!next) {
          throw new AppError(
            "AGENT_REMINDER_RECURRENCE_EXHAUSTED",
            "Не удалось вычислить следующее время повторяющегося напоминания",
          );
        }
        await client.query(
          `UPDATE reminders
           SET status = 'active', occurrence_index = $2, due_at = $3, available_at = $3,
               attempts = 0, lease_token = NULL, lease_expires_at = NULL,
               dispatch_started_at = NULL, delayed_by_quiet_hours = false,
               last_error_code = NULL, updated_at = $4
           WHERE id = $1`,
          [job.id, next.next_index, next.next_due_at, completedAt],
        );
      }
      await client.query(
        `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
         VALUES ($1, 'reminder.delivered', $2, jsonb_build_object('delayed', $3::boolean))`,
        [current.family_id, job.id, job.delayed],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async fail(job: ClaimedReminder, errorCode: string): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<{ family_id: string }>(
        `UPDATE reminders
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             dispatch_started_at = NULL, last_error_code = $3, updated_at = now()
         WHERE id = $1 AND status = 'leased' AND lease_token = $2
         RETURNING family_id`,
        [job.id, job.leaseToken, errorCode],
      );
      if (!failed.rows[0]) {
        throw new AppError("AGENT_REMINDER_LEASE_STALE", "Ошибка доставки уже неактуальна");
      }
      await recordFailures(client, [{ family_id: failed.rows[0].family_id, id: job.id }], errorCode);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
