/**
 * PostgreSQL session-retention leasing operations.
 *
 * Exports:
 * - `SessionRetentionClaim`: exclusive Eve storage deletion lease.
 * - `sessionRetentionRepository`: claim, completion, and failure persistence operations.
 */
import { SESSION_RETENTION_LEASE_MS, SESSION_RETENTION_RETRY_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";

/**
 * The cleanup failures that resolve without a human: the Workflow run had not reached a terminal
 * status yet, or its storage is already gone and there is nothing left to delete. Every other code
 * parks the session for an operator, deliberately — a corrupt storage row must not be retried in a
 * loop.
 */
const RETRYABLE_CLEANUP_ERROR_CODES = [
  "AGENT_EVE_SESSION_STORAGE_ACTIVE",
  "AGENT_EVE_SESSION_STORAGE_MISSING",
];

export interface SessionRetentionClaim {
  eveSessionId: string;
  id: string;
  leaseToken: string;
}

export const sessionRetentionRepository = {
  async claimExpiredForDeletion(now: Date): Promise<SessionRetentionClaim | null> {
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + SESSION_RETENTION_LEASE_MS);
    const result = await database().query<{
      eve_session_id: string;
      id: string;
      retention_lease_token: string;
    }>(
      `UPDATE conversation_sessions
          SET retention_lease_token = $2, retention_lease_expires_at = $3
        WHERE id = (
          SELECT id FROM conversation_sessions
            WHERE retired_at IS NOT NULL AND delete_after <= $1
              AND retention_hold = false AND eve_session_id IS NOT NULL
              AND (cleanup_error_code IS NULL OR cleanup_error_code = ANY($4))
              -- The lease timestamp carries the backoff for a retryable failure, so a run that was
              -- still busy is offered again later instead of waiting for a human forever.
              AND (retention_lease_expires_at IS NULL OR retention_lease_expires_at <= $1)
           ORDER BY delete_after, id
           LIMIT 1 FOR UPDATE SKIP LOCKED
        )
      RETURNING id, eve_session_id, retention_lease_token`,
      [now, leaseToken, leaseExpiresAt, RETRYABLE_CLEANUP_ERROR_CODES],
    );
    const row = result.rows[0];
    return row
      ? { eveSessionId: row.eve_session_id, id: row.id, leaseToken: row.retention_lease_token }
      : null;
  },

  async completeDeletion(id: string, leaseToken: string): Promise<void> {
    const result = await database().query(
      "DELETE FROM conversation_sessions WHERE id = $1 AND retention_lease_token = $2",
      [id, leaseToken],
    );
    if (result.rowCount !== 1) {
      throw new AppError(
        "AGENT_SESSION_RETENTION_LEASE_LOST",
        "Не удалось подтвердить удаление контекста",
      );
    }
  },

  /**
   * The failure is kept for diagnosis, and the lease is held until the retry moment instead of
   * being released: the table requires the token and the expiry to be set or cleared together,
   * and a held lease is exactly what "do not offer this session again yet" means here.
   */
  async failDeletion(
    id: string, leaseToken: string, errorCode: string, now: Date,
  ): Promise<void> {
    const retryAt = new Date(now.getTime() + SESSION_RETENTION_RETRY_MS);
    const result = await database().query(
      `UPDATE conversation_sessions
          SET cleanup_error_code = $3, retention_lease_expires_at = $4
        WHERE id = $1 AND retention_lease_token = $2`,
      [id, leaseToken, errorCode, retryAt],
    );
    if (result.rowCount !== 1) {
      throw new AppError(
        "AGENT_SESSION_RETENTION_LEASE_LOST",
        "Не удалось сохранить ошибку удаления контекста",
      );
    }
  },
};
