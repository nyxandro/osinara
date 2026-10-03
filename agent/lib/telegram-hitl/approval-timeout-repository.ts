/**
 * Durable persistence for expired Telegram HITL approvals.
 *
 * Export:
 * - `approvalTimeoutRepository`: leased claim and terminal settlement of unanswered approvals.
 *
 * Key constructs:
 * - A lease separates "selected for cancellation" from "cancelled", so a failed response retries.
 * - a continuation runs with the auth its response delivers, so the claim rebuilds the same
 *   freshly revalidated auth the interactive callback path uses; an unprovable approver is skipped.
 * - Only a prompt whose session still owns the parked turn is eligible: settling a stale row would
 *   clear `pending_operation` for a different, genuinely pending approval.
 */
import type { PoolClient } from "pg";

import {
  TELEGRAM_HITL_TIMEOUT_LEASE_MS,
  TELEGRAM_HITL_TIMEOUT_SWEEP_BATCH_SIZE,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { resolveCurrentApprovalAuth, type ApprovalAuthRow } from "./approval-auth.js";
import type {
  ApprovalTimeoutRepository,
  TimedOutApprovalClaim,
} from "./approval-timeout.js";

interface ClaimRow extends ApprovalAuthRow {
  id: string;
  prompt_text: string | null;
  request_id: string;
  request_kind: "question" | "tool-approval";
  timeout_lease_token: string;
  tool_name: string | null;
}

const APPROVER_UNPROVABLE = "AGENT_APPROVAL_TIMEOUT_APPROVER_UNPROVABLE";

export const approvalTimeoutRepository: ApprovalTimeoutRepository = {
  async claimExpired(now, timeoutMilliseconds) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ClaimRow>(
        `WITH candidate AS (
           SELECT approval.id
             FROM telegram_hitl_approvals approval
             JOIN conversation_sessions session
               ON session.id = approval.application_session_id
            WHERE approval.consumed_at IS NULL
              AND approval.request_kind IN ('question', 'tool-approval')
              AND approval.created_at
                    <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
              AND (approval.timeout_lease_expires_at IS NULL
                   OR approval.timeout_lease_expires_at <= $1::timestamptz)
              AND session.eve_session_id = approval.eve_session_id
              AND session.retired_at IS NULL
              AND session.pending_operation
            ORDER BY approval.timeout_attempts, approval.created_at, approval.id
            LIMIT $3::integer
            FOR UPDATE OF approval, session SKIP LOCKED
         )
         UPDATE telegram_hitl_approvals approval
            SET timeout_lease_token = gen_random_uuid(),
                timeout_lease_expires_at
                  = $1::timestamptz + ($4::bigint * interval '1 millisecond')
           FROM candidate, conversation_sessions session
          WHERE approval.id = candidate.id
            AND session.id = approval.application_session_id
         RETURNING approval.application_session_id, approval.eve_session_id, approval.id,
                   approval.expected_telegram_user_id, approval.prompt_text, approval.request_id,
                   approval.request_kind, approval.telegram_chat_id, approval.telegram_chat_type,
                   approval.telegram_message_id::text AS telegram_message_id,
                   approval.telegram_message_thread_id::text AS telegram_message_thread_id,
                   approval.timeout_lease_token::text AS timeout_lease_token, approval.tool_name,
                   session.family_id, session.group_id, session.owner_user_id, session.scope, session.thread_id`,
        [
          now,
          timeoutMilliseconds,
          TELEGRAM_HITL_TIMEOUT_SWEEP_BATCH_SIZE,
          TELEGRAM_HITL_TIMEOUT_LEASE_MS,
        ],
      );

      const claims: TimedOutApprovalClaim[] = [];
      for (const row of result.rows) {
        // Only freshly read database policy may enter the resumed turn; an approver who lost the
        // required role cannot be represented, so the prompt stays pending and observable.
        const auth = await resolveCurrentApprovalAuth(client, row);
        if (auth === null) {
          await releaseLease(client, row.id, row.timeout_lease_token);
          console.error(JSON.stringify({ approvalId: row.id, code: APPROVER_UNPROVABLE }));
          continue;
        }
        claims.push(toClaim(row, auth));
      }
      await client.query("COMMIT");
      return claims;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async completeTimeout(claim, now) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const settled = await client.query(
        `UPDATE telegram_hitl_approvals
            SET consumed_at = $3::timestamptz, timed_out_at = $3::timestamptz,
                timeout_lease_token = NULL, timeout_lease_expires_at = NULL
          WHERE id = $1 AND timeout_lease_token = $2::uuid AND consumed_at IS NULL`,
        [claim.id, claim.leaseToken, now],
      );
      if (settled.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      // Releasing the last pending approval also releases the unconditional rotation veto.
      await client.query(
        `UPDATE conversation_sessions session
            SET pending_operation = EXISTS (
                  SELECT 1 FROM telegram_hitl_approvals pending
                   WHERE pending.application_session_id = session.id
                     AND pending.eve_session_id = $2
                     AND pending.consumed_at IS NULL
                ),
                pending_request_id = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM telegram_hitl_approvals pending
                     WHERE pending.application_session_id = session.id
                       AND pending.eve_session_id = $2
                       AND pending.consumed_at IS NULL
                  ) THEN pending_request_id
                  ELSE NULL
                END,
                task_state = CASE
                  WHEN kind = 'task' AND NOT EXISTS (
                    SELECT 1 FROM telegram_hitl_approvals pending
                     WHERE pending.application_session_id = session.id
                       AND pending.eve_session_id = $2
                       AND pending.consumed_at IS NULL
                  ) THEN 'running'::conversation_task_state
                  ELSE task_state
                END
          WHERE session.id = $1 AND session.retired_at IS NULL
            AND session.eve_session_id = $2`,
        [claim.applicationSessionId, claim.agentSessionId],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async failTimeout(claim, errorCode) {
    // The row stays pending on purpose: the next sweep retries the cancellation. The attempt counter
    // keeps an unsettleable prompt from holding the head of the queue forever.
    const result = await database().query<{ timeout_attempts: number }>(
      `UPDATE telegram_hitl_approvals
          SET timeout_lease_token = NULL, timeout_lease_expires_at = NULL,
              timeout_attempts = timeout_attempts + 1
        WHERE id = $1 AND timeout_lease_token = $2::uuid
       RETURNING timeout_attempts`,
      [claim.id, claim.leaseToken],
    );
    console.error(JSON.stringify({
      approvalId: claim.id,
      attempts: result.rows[0]?.timeout_attempts ?? null,
      code: errorCode,
    }));
  },
};

async function releaseLease(
  client: PoolClient,
  id: string,
  leaseToken: string,
): Promise<void> {
  await client.query(
    `UPDATE telegram_hitl_approvals
        SET timeout_lease_token = NULL, timeout_lease_expires_at = NULL,
            timeout_attempts = timeout_attempts + 1
      WHERE id = $1 AND timeout_lease_token = $2::uuid`,
    [id, leaseToken],
  );
}

function toClaim(row: ClaimRow, auth: TimedOutApprovalClaim["auth"]): TimedOutApprovalClaim {
  return {
    applicationSessionId: row.application_session_id,
    auth,
    agentSessionId: row.eve_session_id,
    id: row.id,
    kind: row.request_kind,
    leaseToken: row.timeout_lease_token,
    promptText: requirePromptText(row),
    requestId: row.request_id,
    telegramChatId: row.telegram_chat_id,
    telegramMessageId: row.telegram_message_id,
    toolName: row.tool_name,
  };
}

function requirePromptText(row: ClaimRow): string {
  // `telegram_hitl_pending_presentation` guarantees this for every unanswered prompt.
  if (row.prompt_text === null || row.prompt_text.length === 0) {
    throw new AppError(
      "AGENT_APPROVAL_TIMEOUT_PROMPT_MISSING",
      "Не удалось закрыть просроченный запрос подтверждения: текст запроса не сохранён",
    );
  }
  return row.prompt_text;
}
