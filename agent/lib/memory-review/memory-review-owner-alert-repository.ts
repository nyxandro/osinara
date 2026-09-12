/**
 * Durable outbox for severe memory-review owner alerts.
 *
 * Exports:
 * - `MemoryReviewOwnerAlertClaim`: one exact private delivery attempt leased to a worker.
 * - `enqueueMemoryReviewOwnerAlert`: transaction-local idempotent alert creation.
 * - `memoryReviewOwnerAlertRepository`: one-shot claim and terminal delivery transitions.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";

export interface MemoryReviewOwnerAlertClaim {
  alertId: string;
  batchId: string;
  deliveryToken: string;
  diagnosticCode: string;
  fromSequence: string;
  groupTitle: string;
  ownerTelegramUserId: string;
  throughSequence: string;
}

export async function enqueueMemoryReviewOwnerAlert(
  client: PoolClient,
  batchId: string,
  diagnosticCode: string,
): Promise<void> {
  const kind = diagnosticCode === "AGENT_MEMORY_REVIEW_WAITING_MODEL" ? "waiting_model"
    : diagnosticCode === "AGENT_MEMORY_REVIEW_PARTIAL_RESULT" ? "partial" : "blocked";
  const result = await client.query(
    `INSERT INTO memory_review_owner_alerts
       (batch_id, family_id, group_id, group_title_snapshot, from_sequence,
          through_sequence, batch_diagnostic_code, recovery_generation, model_recovery_generation, notification_kind)
     SELECT batch.id, conversation.family_id, telegram_group.id, telegram_group.title,
              batch.from_sequence, batch.through_sequence, $2, batch.recovery_attempts, batch.model_recovery_generation, $3
       FROM memory_review_batches AS batch
       JOIN application_conversations AS conversation ON conversation.id = batch.conversation_id
       JOIN telegram_groups AS telegram_group ON telegram_group.id = conversation.telegram_group_id
      -- Compared as text because migration tests exercise this insert against schemas older
      -- than the terminal status that was added last.
       WHERE batch.id = $1 AND batch.status::text IN ('failed', 'ambiguous', 'skipped', 'waiting_model')
      ON CONFLICT (batch_id, recovery_generation, model_recovery_generation, notification_kind) DO NOTHING`,
    [batchId, diagnosticCode, kind],
  );
  if (result.rowCount !== 1) {
    const existing = await client.query(
      `SELECT 1 FROM memory_review_owner_alerts AS alert
        JOIN memory_review_batches AS batch ON batch.id = alert.batch_id
       WHERE alert.batch_id = $1
          AND alert.recovery_generation = batch.recovery_attempts
          AND alert.model_recovery_generation = batch.model_recovery_generation AND alert.notification_kind = $2`,
      [batchId, kind],
    );
    if (!existing.rows[0]) throw new AppError(
      "AGENT_MEMORY_REVIEW_OWNER_ALERT_CREATE_FAILED",
      "Не удалось подготовить уведомление владельца о сбое проверки памяти",
    );
  }
}

async function terminalizeStaleDeliveries(client: PoolClient, now: Date): Promise<void> {
  // A timed-out send may already have reached Telegram, so alert delivery remains one-shot.
  await client.query(
    `UPDATE memory_review_owner_alerts
        SET status = 'ambiguous',
            delivery_diagnostic_code = 'AGENT_MEMORY_REVIEW_OWNER_ALERT_TIMEOUT_AMBIGUOUS',
            delivery_token = NULL, delivery_lease_expires_at = NULL,
            completed_at = $1, updated_at = $1
      WHERE status = 'delivering' AND delivery_lease_expires_at <= $1`,
    [now],
  );
}

async function terminalizeOwnerlessAlerts(
  client: PoolClient,
  now: Date,
): Promise<Array<{ batch_id: string; id: string }>> {
  // A broken family invariant cannot poison alerts that still have a valid current owner.
  const result = await client.query<{ batch_id: string; id: string }>(
    `UPDATE memory_review_owner_alerts AS alert
        SET status = 'failed',
            delivery_diagnostic_code = 'AGENT_MEMORY_REVIEW_OWNER_ALERT_OWNER_MISSING',
            completed_at = $1, updated_at = $1
      WHERE alert.status = 'pending' AND NOT EXISTS (
        SELECT 1 FROM family_memberships AS membership
         WHERE membership.family_id = alert.family_id AND membership.role = 'owner'
      )
      RETURNING alert.id, alert.batch_id`,
    [now],
  );
  return result.rows;
}

export const memoryReviewOwnerAlertRepository = {
  async claimPending(input: {
    leaseMilliseconds: number;
    limit: number;
    now: Date;
  }): Promise<MemoryReviewOwnerAlertClaim[]> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await terminalizeStaleDeliveries(client, input.now);
      // An unsent waiting notice is obsolete once this attempt recovered or became a hard failure.
      await client.query(`DELETE FROM memory_review_owner_alerts alert USING memory_review_batches batch
        WHERE alert.batch_id = batch.id AND alert.status = 'pending' AND alert.notification_kind = 'waiting_model'
          AND (batch.status <> 'waiting_model' OR batch.model_recovery_generation <> alert.model_recovery_generation)`);
      const ownerless = await terminalizeOwnerlessAlerts(client, input.now);
      const result = await client.query<{
        batch_id: string;
        batch_diagnostic_code: string;
        delivery_token: string;
        from_sequence: string;
        group_title_snapshot: string;
        id: string;
        owner_telegram_user_id: string;
        through_sequence: string;
      }>(
        `WITH candidates AS (
           SELECT alert.id, owner.telegram_user_id AS owner_telegram_user_id
             FROM memory_review_owner_alerts AS alert
             JOIN family_memberships AS membership
               ON membership.family_id = alert.family_id AND membership.role = 'owner'
             JOIN users AS owner ON owner.id = membership.user_id
            WHERE alert.status = 'pending'
            ORDER BY alert.created_at, alert.id
            FOR UPDATE OF alert SKIP LOCKED
            LIMIT $2
         )
         UPDATE memory_review_owner_alerts AS alert
            SET status = 'delivering', delivery_token = gen_random_uuid(),
                delivery_lease_expires_at = $1::timestamptz +
                  $3 * interval '1 millisecond',
                delivery_started_at = $1::timestamptz, updated_at = $1::timestamptz
           FROM candidates
          WHERE alert.id = candidates.id
         RETURNING alert.id, alert.batch_id, alert.delivery_token::text,
                   alert.batch_diagnostic_code, alert.from_sequence::text,
                   alert.through_sequence::text, alert.group_title_snapshot,
                   candidates.owner_telegram_user_id`,
        [input.now, input.limit, input.leaseMilliseconds],
      );
      await client.query("COMMIT");
      for (const alert of ownerless) {
        console.error(JSON.stringify({
          alertId: alert.id,
          batchId: alert.batch_id,
          code: "AGENT_MEMORY_REVIEW_OWNER_ALERT_OWNER_MISSING",
        }));
      }
      return result.rows.map((row) => ({
        alertId: row.id,
        batchId: row.batch_id,
        deliveryToken: row.delivery_token,
        diagnosticCode: row.batch_diagnostic_code,
        fromSequence: row.from_sequence,
        groupTitle: row.group_title_snapshot,
        ownerTelegramUserId: row.owner_telegram_user_id,
        throughSequence: row.through_sequence,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async markDelivered(alert: MemoryReviewOwnerAlertClaim): Promise<void> {
    const result = await database().query(
      `UPDATE memory_review_owner_alerts
          SET status = 'delivered', delivery_token = NULL, delivery_lease_expires_at = NULL,
              completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'delivering' AND delivery_token = $2`,
      [alert.alertId, alert.deliveryToken],
    );
    if (result.rowCount !== 1) throw new AppError(
      "AGENT_MEMORY_REVIEW_OWNER_ALERT_DELIVERY_STATE_INVALID",
      "Не удалось подтвердить доставку уведомления владельцу",
    );
  },

  async markFailed(
    alert: MemoryReviewOwnerAlertClaim,
    input: { diagnosticCode: string; status: "ambiguous" | "failed" },
  ): Promise<void> {
    const result = await database().query(
      `UPDATE memory_review_owner_alerts
          SET status = $3::memory_review_owner_alert_status,
              delivery_diagnostic_code = $4,
              delivery_token = NULL, delivery_lease_expires_at = NULL,
              completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'delivering' AND delivery_token = $2`,
      [alert.alertId, alert.deliveryToken, input.status, input.diagnosticCode],
    );
    if (result.rowCount !== 1) throw new AppError(
      "AGENT_MEMORY_REVIEW_OWNER_ALERT_FAILURE_STATE_INVALID",
      "Не удалось сохранить ошибку уведомления владельца",
    );
  },
};
