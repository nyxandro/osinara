/**
 * Durable overdue family-task notification queue.
 *
 * Exports:
 * - `ClaimedOverdueTask`: authorization-revalidated Telegram delivery lease.
 * - `taskOverdueRepository`: claim, side-effect marker, completion, and terminal failure.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export interface ClaimedOverdueTask {
  id: string;
  leaseToken: string;
  messageThreadId: string | null;
  telegramChatId: string;
  title: string;
}

interface ClaimOptions {
  leaseMilliseconds: number;
  limit: number;
  now: Date;
}

interface ClaimRow {
  id: string;
  lease_token: string;
  message_thread_id: string | null;
  telegram_chat_id: string;
  title: string;
}

export const taskOverdueRepository = {
  async claimDue(options: ClaimOptions): Promise<ClaimedOverdueTask[]> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Telegram has no idempotency key, so post-start lease expiry is terminal ambiguity.
      const ambiguous = await client.query<{ family_id: string; id: string }>(
        `UPDATE family_tasks
         SET overdue_error_code = 'AGENT_TASK_OVERDUE_DELIVERY_AMBIGUOUS',
             overdue_lease_token = NULL, overdue_lease_expires_at = NULL,
             overdue_dispatch_started_at = NULL, updated_at = $1
         WHERE overdue_lease_expires_at < $1 AND overdue_dispatch_started_at IS NOT NULL
           AND overdue_notified_at IS NULL
         RETURNING id, family_id`,
        [options.now],
      );
      for (const row of ambiguous.rows) {
        await client.query(
          `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
           VALUES ($1, 'task.overdue_delivery_failed', $2,
                   jsonb_build_object('code', 'AGENT_TASK_OVERDUE_DELIVERY_AMBIGUOUS'))`,
          [row.family_id, row.id],
        );
      }
      await client.query(
        `UPDATE family_tasks
         SET overdue_lease_token = NULL, overdue_lease_expires_at = NULL, updated_at = $1
         WHERE overdue_lease_expires_at < $1 AND overdue_dispatch_started_at IS NULL
           AND overdue_notified_at IS NULL`,
        [options.now],
      );

      // Revoked membership or a changed group trust zone invalidates delivery permanently.
      await client.query(
        `UPDATE family_tasks AS task
         SET overdue_error_code = 'AGENT_TASK_OVERDUE_DESTINATION_REVOKED', updated_at = $1
         WHERE task.scope = 'family' AND task.status = 'open'
           AND task.overdue_notified_at IS NULL AND task.overdue_error_code IS NULL
           AND (
             NOT EXISTS (
               SELECT 1 FROM family_memberships
               WHERE family_id = task.family_id AND user_id = task.assignee_user_id
             ) OR NOT EXISTS (
               SELECT 1 FROM telegram_groups AS group_row
               WHERE group_row.id = task.group_id AND group_row.family_id = task.family_id
                 AND group_row.telegram_chat_id = task.telegram_chat_id
                 AND group_row.type = 'family_private'
             )
           )`,
        [options.now],
      );

      // The assignee's current quiet-hours policy delays the ordinary group notification.
      await client.query(
        `UPDATE family_tasks AS task
         SET overdue_available_at = (
               (($1 AT TIME ZONE settings.timezone)::date + settings.quiet_end) +
               make_interval(days => CASE
                 WHEN settings.quiet_start > settings.quiet_end
                   AND ($1 AT TIME ZONE settings.timezone)::time >= settings.quiet_start
                 THEN 1 ELSE 0 END)
             ) AT TIME ZONE settings.timezone,
             updated_at = $1
         FROM user_notification_settings AS settings
         WHERE task.assignee_user_id = settings.user_id AND task.scope = 'family'
           AND task.status = 'open' AND task.overdue_notified_at IS NULL
           AND task.overdue_error_code IS NULL AND task.overdue_available_at <= $1
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

      const claimed = await client.query<ClaimRow>(
        `WITH candidates AS (
           SELECT task.id FROM family_tasks AS task
           WHERE task.scope = 'family' AND task.status = 'open'
             AND task.overdue_notified_at IS NULL AND task.overdue_error_code IS NULL
             AND task.overdue_available_at <= $1 AND task.overdue_lease_token IS NULL
           ORDER BY task.overdue_available_at, task.id
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE family_tasks AS task
         SET overdue_lease_token = gen_random_uuid(),
             overdue_lease_expires_at = $1 + ($3::text || ' milliseconds')::interval,
             overdue_dispatch_started_at = NULL, updated_at = $1
         FROM candidates WHERE task.id = candidates.id
         RETURNING task.id, task.title, task.telegram_chat_id,
                   task.message_thread_id::text, task.overdue_lease_token::text AS lease_token`,
        [options.now, options.limit, options.leaseMilliseconds],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        id: row.id,
        leaseToken: row.lease_token,
        messageThreadId: row.message_thread_id,
        telegramChatId: row.telegram_chat_id,
        title: row.title,
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
      `UPDATE family_tasks SET overdue_dispatch_started_at = now(), updated_at = now()
       WHERE id = $1 AND overdue_lease_token = $2 AND overdue_dispatch_started_at IS NULL`,
      [id, leaseToken],
    );
    if (!result.rowCount) {
      throw new AppError("AGENT_TASK_OVERDUE_LEASE_STALE", "Доставка задачи уже неактуальна");
    }
  },

  async complete(job: ClaimedOverdueTask): Promise<void> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ family_id: string }>(
        `UPDATE family_tasks
         SET overdue_notified_at = now(), overdue_lease_token = NULL,
             overdue_lease_expires_at = NULL, overdue_dispatch_started_at = NULL, updated_at = now()
         WHERE id = $1 AND overdue_lease_token = $2 AND overdue_dispatch_started_at IS NOT NULL
         RETURNING family_id`,
        [job.id, job.leaseToken],
      );
      if (!result.rows[0]) {
        throw new AppError("AGENT_TASK_OVERDUE_LEASE_STALE", "Доставка задачи уже неактуальна");
      }
      await client.query(
        `INSERT INTO audit_events (family_id, event_type, subject_id, metadata)
         VALUES ($1, 'task.overdue_delivered', $2, '{}'::jsonb)`,
        [result.rows[0].family_id, job.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async fail(job: ClaimedOverdueTask, errorCode: string): Promise<void> {
    await database().query(
      `UPDATE family_tasks
       SET overdue_error_code = $3, overdue_lease_token = NULL,
           overdue_lease_expires_at = NULL, overdue_dispatch_started_at = NULL, updated_at = now()
       WHERE id = $1 AND overdue_lease_token = $2`,
      [job.id, job.leaseToken, errorCode],
    );
  },
};
