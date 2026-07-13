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
  REMINDER_DISPATCH_LATE_AFTER_MILLISECONDS,
  REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS,
  REMINDER_RECURRENCE_MAX_SKIPPED_OCCURRENCES,
} from "./reminder-config.js";
import type { ReminderRecurrenceUnit, ReminderScope } from "./reminder-record.js";

export interface ClaimedReminder {
  content: string;
  delayed: boolean;
  dueAt: string;
  id: string;
  leaseToken: string;
  messageThreadId: string | null;
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
  id: string;
  lease_token: string;
  message_thread_id: string | null;
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
        `UPDATE scheduled_tasks
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
        `UPDATE scheduled_tasks
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'AGENT_REMINDER_DELIVERY_ATTEMPTS_EXHAUSTED', updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
           AND attempts >= $2
         RETURNING id, family_id`,
        [options.now, REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS],
      );
      await recordFailures(client, exhausted.rows, "AGENT_REMINDER_DELIVERY_ATTEMPTS_EXHAUSTED");
      await client.query(
        `UPDATE scheduled_tasks
         SET status = 'active', lease_token = NULL, lease_expires_at = NULL, updated_at = $1
         WHERE status = 'leased' AND lease_expires_at < $1 AND dispatch_started_at IS NULL
           AND attempts < $2`,
        [options.now, REMINDER_DISPATCH_MAX_SAFE_ATTEMPTS],
      );

      // Removed memberships or changed trust zones invalidate a proactive destination fail-closed.
      const invalid = await client.query<{ family_id: string; id: string }>(
        `UPDATE scheduled_tasks AS task
         SET status = 'failed', last_error_code = 'AGENT_REMINDER_DESTINATION_REVOKED',
             updated_at = $1
         WHERE task.status = 'active' AND (
           NOT EXISTS (
             SELECT 1 FROM family_memberships
             WHERE family_id = task.family_id AND user_id = task.author_user_id
           ) OR (
             task.scope = 'family' AND NOT EXISTS (
               SELECT 1 FROM telegram_groups AS group_row
               WHERE group_row.id = task.group_id AND group_row.family_id = task.family_id
                 AND group_row.telegram_chat_id = task.telegram_chat_id
                 AND group_row.type = 'family_private'
             )
           )
         )
         RETURNING task.id, task.family_id`,
        [options.now],
      );
      await recordFailures(client, invalid.rows, "AGENT_REMINDER_DESTINATION_REVOKED");

      // Quiet hours defer availability while retaining the original due_at for delayed-delivery notice.
      await client.query(
        `UPDATE scheduled_tasks AS task
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
         WHERE task.status = 'active' AND task.author_user_id = settings.user_id
           AND task.available_at <= $1
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
           SELECT task.id
           FROM scheduled_tasks AS task
           JOIN family_memberships AS membership
             ON membership.family_id = task.family_id AND membership.user_id = task.author_user_id
           WHERE task.status = 'active' AND task.available_at <= $1
             AND task.attempts < $4
           ORDER BY task.available_at, task.id
           FOR UPDATE OF task SKIP LOCKED
           LIMIT $2
         )
         UPDATE scheduled_tasks AS task
         SET status = 'leased', attempts = attempts + 1, lease_token = gen_random_uuid(),
             lease_expires_at = $1 + ($3::text || ' milliseconds')::interval,
             dispatch_started_at = NULL, updated_at = $1
         FROM candidates
         WHERE task.id = candidates.id
         RETURNING task.id, task.content, task.scope, task.timezone, task.telegram_chat_id,
                   task.message_thread_id::text, task.due_at, task.lease_token::text,
                   (task.delayed_by_quiet_hours OR task.due_at < $1 - ($5::text || ' milliseconds')::interval) AS delayed`,
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
        id: row.id,
        leaseToken: row.lease_token,
        messageThreadId: row.message_thread_id,
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
      `UPDATE scheduled_tasks SET dispatch_started_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_token = $2
         AND dispatch_started_at IS NULL`,
      [id, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError(
        "AGENT_REMINDER_LEASE_STALE",
        "Задача доставки напоминания уже неактуальна",
      );
    }
  },

  async complete(job: ClaimedReminder, completedAt: Date): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const task = await client.query<{
        family_id: string;
        recurrence_unit: ReminderRecurrenceUnit | null;
      }>(
        `SELECT family_id, recurrence_unit FROM scheduled_tasks
         WHERE id = $1 AND status = 'leased' AND lease_token = $2
           AND dispatch_started_at IS NOT NULL
         FOR UPDATE`,
        [job.id, job.leaseToken],
      );
      const current = task.rows[0];
      if (!current) {
        throw new AppError("AGENT_REMINDER_LEASE_STALE", "Задача доставки уже неактуальна");
      }

      if (current.recurrence_unit === null) {
        await client.query(
          `UPDATE scheduled_tasks
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
             SELECT task.family_id, task.occurrence_index + 1 AS next_index,
                    CASE task.recurrence_unit
                      WHEN 'daily' THEN (task.recurrence_anchor_local + make_interval(days => task.recurrence_interval * (task.occurrence_index + 1))) AT TIME ZONE task.timezone
                      WHEN 'weekly' THEN (task.recurrence_anchor_local + make_interval(days => 7 * task.recurrence_interval * (task.occurrence_index + 1))) AT TIME ZONE task.timezone
                      WHEN 'monthly' THEN (task.recurrence_anchor_local + make_interval(months => task.recurrence_interval * (task.occurrence_index + 1))) AT TIME ZONE task.timezone
                    END AS next_due_at,
                    task.occurrence_index AS initial_index
             FROM scheduled_tasks AS task WHERE task.id = $1
             UNION ALL
             SELECT occurrence.family_id, occurrence.next_index + 1,
                    CASE task.recurrence_unit
                      WHEN 'daily' THEN (task.recurrence_anchor_local + make_interval(days => task.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE task.timezone
                      WHEN 'weekly' THEN (task.recurrence_anchor_local + make_interval(days => 7 * task.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE task.timezone
                      WHEN 'monthly' THEN (task.recurrence_anchor_local + make_interval(months => task.recurrence_interval * (occurrence.next_index + 1))) AT TIME ZONE task.timezone
                    END,
                    occurrence.initial_index
             FROM occurrences AS occurrence
             JOIN scheduled_tasks AS task ON task.id = $1
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
          `UPDATE scheduled_tasks
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
        `UPDATE scheduled_tasks
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
