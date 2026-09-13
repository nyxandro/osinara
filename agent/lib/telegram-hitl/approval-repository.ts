/**
 * Durable Telegram HITL approval persistence.
 *
 * Exports:
 * - `TelegramHitlApprovalRepository`: injectable registration and authorization contract.
 * - `telegramHitlApprovalRepository`: PostgreSQL implementation with atomic callback claims.
 * - Approval input/result types used by Telegram channel boundaries.
 */
import type { SessionAuthContext } from "eve/context";
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { bindCallbackIngress, bindTextReplyIngress } from "./callback-ingress-binding.js";
import {
  resolveCurrentApprovalAuth,
  type ApprovalAuthRow,
} from "./approval-auth.js";

type TelegramChatType = "group" | "private" | "supergroup";

export interface RegisterTelegramHitlApprovalInput {
  eveTurnId?: string;
  applicationSessionId: string;
  /** Framework-owned request source; the confirmation window applies only to human-answerable kinds. */
  kind: "question" | "session-limit" | "tool-approval";
  callbackData: readonly string[];
  callbackOptions: readonly {
    callbackData: string;
    label: string;
    optionId: string;
  }[];
  eveSessionId: string;
  requestId: string;
  promptText: string;
  telegramChatId: string;
  telegramChatType: TelegramChatType;
  telegramMessageId: string;
  telegramMessageThreadId: string | null;
  telegramUserId: string;
  toolCallId: string;
  toolInputHash: string;
  toolName: string;
}

export interface ClaimTelegramHitlCallbackInput {
  ingress?: { updateId: string; dispatchId: string; callbackQueryId: string };
  baseContinuationToken: string;
  callbackData: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId: string;
}

export interface AuthorizeTelegramHitlReplyInput {
  ingress?: { updateId: string; dispatchId: string };
  baseContinuationToken: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId: string;
}

export type TelegramHitlCallbackClaim =
  | {
      auth: SessionAuthContext;
      continuationToken: string;
      promptText: string;
      selectedOptionId: string;
      selectedOptionLabel: string;
      status: "authorized";
      replayed?: boolean;
    }
  | { status: "expired" | "forbidden" };
export type TelegramHitlReplyAuthorization =
  "authorized" | "expired" | "forbidden" | "not_applicable";

export interface TelegramHitlApprovalRepository {
  authorizeReply(input: AuthorizeTelegramHitlReplyInput): Promise<TelegramHitlReplyAuthorization>;
  claimCallback(input: ClaimTelegramHitlCallbackInput): Promise<TelegramHitlCallbackClaim>;
  clearForEveSession(applicationSessionId: string, eveSessionId: string): Promise<void>;
  hasPendingForSession(applicationSessionId: string, eveSessionId: string): Promise<boolean>;
  requireToolExecutionApproval(input: {
    applicationSessionId: string;
    eveSessionId: string;
    telegramUserId: string;
    toolCallId: string;
    toolInputHash: string;
    toolName: string;
  }): Promise<void>;
  register(input: RegisterTelegramHitlApprovalInput): Promise<void>;
}

interface ApprovalRow extends ApprovalAuthRow {
  request_kind: "question" | "tool-approval" | "session-limit";
  eve_turn_id: string | null;
  consumed_callback_query_id: string | null;
  consumed_reply_update_id: string | null;
  id: string;
  callback_data: string[];
  callback_options: unknown;
  consumed_at: Date | null;
  continuation_token: string;
  pending_operation: boolean;
  prompt_text: string | null;
  retired_at: Date | null;
  session_eve_session_id: string | null;
}

async function lockApproval(
  client: PoolClient,
  telegramChatId: string,
  telegramMessageId: string,
): Promise<ApprovalRow | null> {
  const result = await client.query<ApprovalRow>(
    `SELECT a.application_session_id,
            a.callback_data,
             a.callback_options,
             a.request_kind,
            a.consumed_at,
             a.eve_session_id,
             a.eve_turn_id,a.consumed_callback_query_id,a.consumed_reply_update_id::text,
            a.expected_telegram_user_id,
            a.id,
            a.prompt_text,
            a.telegram_chat_id,
            a.telegram_chat_type,
            a.telegram_message_id::text,
            a.telegram_message_thread_id::text,
            s.continuation_token,
            s.eve_session_id AS session_eve_session_id,
            s.family_id,
            s.group_id,
            s.owner_user_id,
            s.pending_operation,
            s.retired_at,
            s.scope
       FROM telegram_hitl_approvals a
       JOIN conversation_sessions s ON s.id = a.application_session_id
      WHERE a.telegram_chat_id = $1
        AND a.telegram_message_id = $2
      FOR UPDATE OF a, s`,
    [telegramChatId, telegramMessageId],
  );
  return result.rows[0] ?? null;
}

function isPendingApproval(row: ApprovalRow): boolean {
  return row.consumed_at === null &&
    row.pending_operation &&
    row.retired_at === null &&
    row.session_eve_session_id === row.eve_session_id;
}

function selectedCallbackOption(
  row: ApprovalRow,
  callbackData: string,
): { label: string; optionId: string } | null {
  if (!Array.isArray(row.callback_options)) return null;
  for (const option of row.callback_options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const value = option as Record<string, unknown>;
    if (
      value.callbackData === callbackData &&
      typeof value.label === "string" && value.label &&
      typeof value.optionId === "string" && value.optionId
    ) return { label: value.label, optionId: value.optionId };
  }
  return null;
}

async function routeBelongsToSession(
  client: PoolClient,
  baseContinuationToken: string,
  applicationSessionId: string,
): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM conversation_session_routes
        WHERE base_continuation_token = $1
          AND session_id = $2
     ) AS matches`,
    [baseContinuationToken, applicationSessionId],
  );
  return result.rows[0]?.matches === true;
}

async function routeHasPendingOperation(
  client: PoolClient,
  baseContinuationToken: string,
): Promise<boolean> {
  const result = await client.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM conversation_session_routes r
         JOIN conversation_sessions s ON s.id = r.session_id
        WHERE r.base_continuation_token = $1
          AND s.pending_operation = true
          AND s.retired_at IS NULL
     ) AS pending`,
    [baseContinuationToken],
  );
  return result.rows[0]?.pending === true;
}

export const telegramHitlApprovalRepository: TelegramHitlApprovalRepository = {
  async register(input) {
    await database().query(
      `INSERT INTO telegram_hitl_approvals
         (application_session_id, eve_session_id, request_id,
           telegram_chat_id, telegram_chat_type, telegram_message_id,
           telegram_message_thread_id, expected_telegram_user_id, callback_data,
            prompt_text, callback_options, tool_call_id, tool_name, tool_input_hash,
             request_kind,eve_turn_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,$16)
       ON CONFLICT (application_session_id, eve_session_id, request_id) DO UPDATE
         SET telegram_chat_id = EXCLUDED.telegram_chat_id,
             telegram_chat_type = EXCLUDED.telegram_chat_type,
             telegram_message_id = EXCLUDED.telegram_message_id,
             telegram_message_thread_id = EXCLUDED.telegram_message_thread_id,
              expected_telegram_user_id = EXCLUDED.expected_telegram_user_id,
              callback_data = EXCLUDED.callback_data,
              prompt_text = EXCLUDED.prompt_text,
               callback_options = EXCLUDED.callback_options,
               tool_call_id = EXCLUDED.tool_call_id,
               tool_name = EXCLUDED.tool_name,
               tool_input_hash = EXCLUDED.tool_input_hash,
                request_kind = EXCLUDED.request_kind,
                eve_turn_id = EXCLUDED.eve_turn_id,consumed_callback_query_id=NULL,consumed_reply_update_id=NULL,
              -- A replayed request re-opens the prompt, so no timeout state may survive it.
              timed_out_at = NULL,
              timeout_lease_token = NULL,
              timeout_lease_expires_at = NULL,
              timeout_attempts = 0,
              selected_option_id = NULL,
              selected_option_label = NULL,
              consumed_at = NULL`,
      [
        input.applicationSessionId,
        input.eveSessionId,
        input.requestId,
        input.telegramChatId,
        input.telegramChatType,
        input.telegramMessageId,
        input.telegramMessageThreadId,
        input.telegramUserId,
        input.callbackData,
        input.promptText,
        JSON.stringify(input.callbackOptions),
        input.toolCallId,
        input.toolName,
        input.toolInputHash,
        input.kind,
        input.eveTurnId ?? null,
      ],
    );
  },

  async requireToolExecutionApproval(input) {
    const result = await database().query<{ authorized: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM telegram_hitl_approvals AS approval
         JOIN conversation_sessions AS session ON session.id = approval.application_session_id
         WHERE approval.application_session_id = $1
           AND approval.eve_session_id = $2
           AND approval.expected_telegram_user_id = $3
           AND approval.tool_call_id = $4
           AND approval.tool_name = $5
           AND approval.tool_input_hash = $6
           AND approval.consumed_at IS NOT NULL
           AND approval.timed_out_at IS NULL
           AND (approval.selected_option_id IS NULL OR approval.selected_option_id = 'approve')
           AND session.eve_session_id = approval.eve_session_id
           AND session.retired_at IS NULL
       ) AS authorized`,
      [input.applicationSessionId, input.eveSessionId, input.telegramUserId,
        input.toolCallId, input.toolName, input.toolInputHash],
    );
    if (result.rows[0]?.authorized !== true) {
      throw new AppError(
        "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID",
        "Не удалось подтвердить решение пользователя для этого действия. Запросите подтверждение заново",
      );
    }
  },

  async claimCallback(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const row = await lockApproval(client, input.telegramChatId, input.telegramMessageId);
      const selectedOption = row ? selectedCallbackOption(row, input.callbackData) : null;
      const replayed = row !== null && input.ingress !== undefined &&
        row.consumed_callback_query_id === input.ingress.callbackQueryId && row.consumed_at !== null &&
        row.retired_at === null && row.session_eve_session_id === row.eve_session_id;
      if (
        !row ||
        (!isPendingApproval(row) && !replayed) ||
        !row.callback_data.includes(input.callbackData) ||
        !selectedOption ||
        !row.prompt_text
      ) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (row.expected_telegram_user_id !== input.telegramUserId) {
        await client.query("ROLLBACK");
        return { status: "forbidden" };
      }
      if (!await routeBelongsToSession(
        client,
        input.baseContinuationToken,
        row.application_session_id,
      )) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      const auth = await resolveCurrentApprovalAuth(client, row);
      if (!auth) {
        await client.query("ROLLBACK");
        return { status: "forbidden" };
      }
      if (input.ingress) await bindCallbackIngress(client, { ...input.ingress, callbackData: input.callbackData, telegramUserId: input.telegramUserId },
        { sessionId: row.eve_session_id, turnId: row.eve_turn_id });
      if (replayed) {
        await client.query("COMMIT");
        return { auth, continuationToken: row.continuation_token, promptText: row.prompt_text,
          selectedOptionId: selectedOption.optionId, selectedOptionLabel: selectedOption.label, status: "authorized", replayed: true };
      }
      const consumed = await client.query(
        `UPDATE telegram_hitl_approvals
            SET consumed_at = now(), selected_option_id = $2, selected_option_label = $3, consumed_callback_query_id=$4
          WHERE id = $1 AND consumed_at IS NULL`,
        [row.id, selectedOption.optionId, selectedOption.label,input.ingress?.callbackQueryId ?? null],
      );
      if (consumed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
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
          WHERE session.id = $1`,
        [row.application_session_id, row.eve_session_id],
      );
      await client.query("COMMIT");
      return {
        auth,
        continuationToken: row.continuation_token,
        promptText: row.prompt_text,
        selectedOptionId: selectedOption.optionId,
        selectedOptionLabel: selectedOption.label,
        status: "authorized",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async authorizeReply(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const row = await lockApproval(client, input.telegramChatId, input.telegramMessageId);
      if (!row) {
        const pending = await routeHasPendingOperation(client, input.baseContinuationToken);
        await client.query("ROLLBACK");
        return pending ? "expired" : "not_applicable";
      }
      const routeMatches = await routeBelongsToSession(
        client,
        input.baseContinuationToken,
        row.application_session_id,
      );
      if (!isPendingApproval(row)) {
        if (input.ingress && row.consumed_reply_update_id === input.ingress.updateId && row.retired_at === null &&
          row.session_eve_session_id === row.eve_session_id && routeMatches && row.expected_telegram_user_id === input.telegramUserId &&
          await resolveCurrentApprovalAuth(client,row)) {
          await bindTextReplyIngress(client,{ ...input.ingress,telegramUserId: input.telegramUserId,
            chatId: input.telegramChatId,promptMessageId: input.telegramMessageId }, { sessionId: row.eve_session_id,turnId: row.eve_turn_id });
          await client.query("COMMIT");
          return "authorized";
        }
        // A consumed or retired prompt is ordinary historical ancestry. Remove any stale alias in
        // the same transaction so it cannot select old task model state during canonical prepare.
        await client.query(
          "DELETE FROM conversation_session_routes WHERE base_continuation_token = $1 AND session_id = $2",
          [input.baseContinuationToken, row.application_session_id],
        );
        await client.query("COMMIT");
        return "not_applicable";
      }
      if (!routeMatches) {
        await client.query("ROLLBACK");
        return "expired";
      }
      // Native Telegram text responses address freeform questions only. Text must not consume a button decision.
      if (row.request_kind !== "question" || row.callback_data.length !== 0) {
        await client.query("COMMIT");
        return "not_applicable";
      }
      if (row.expected_telegram_user_id !== input.telegramUserId) {
        await client.query("ROLLBACK");
        return "forbidden";
      }
      if (input.ingress) {
        if (!await resolveCurrentApprovalAuth(client,row)) { await client.query("ROLLBACK"); return "forbidden"; }
        await bindTextReplyIngress(client,{ ...input.ingress,telegramUserId: input.telegramUserId,
          chatId: input.telegramChatId,promptMessageId: input.telegramMessageId }, { sessionId: row.eve_session_id,turnId: row.eve_turn_id });
      }
      const consumed = await client.query(
        `UPDATE telegram_hitl_approvals
            SET consumed_at = now(),consumed_reply_update_id=$2
          WHERE id = $1 AND consumed_at IS NULL`,
        [row.id,input.ingress?.updateId ?? null],
      );
      if (consumed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return "expired";
      }
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
          WHERE session.id = $1`,
        [row.application_session_id, row.eve_session_id],
      );
      await client.query("COMMIT");
      return "authorized";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async clearForEveSession(applicationSessionId, eveSessionId) {
    await database().query(
      `DELETE FROM telegram_hitl_approvals
        WHERE application_session_id = $1 AND eve_session_id = $2`,
      [applicationSessionId, eveSessionId],
    );
  },

  async hasPendingForSession(applicationSessionId, eveSessionId) {
    const result = await database().query<{ pending: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM telegram_hitl_approvals a
           JOIN conversation_sessions s ON s.id = a.application_session_id
          WHERE a.application_session_id = $1
            AND a.eve_session_id = $2
            AND a.consumed_at IS NULL
            AND s.pending_operation = true
            AND s.retired_at IS NULL
            AND s.eve_session_id = a.eve_session_id
       ) AS pending`,
      [applicationSessionId, eveSessionId],
    );
    return result.rows[0]?.pending === true;
  },
};
