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

import { database } from "../database.js";

type TelegramChatType = "group" | "private" | "supergroup";
type MemoryScope = "family" | "group" | "personal";
type FamilyRole = "member" | "owner" | "recovery_owner";
type GroupType = "external_private" | "external_public" | "family_private";

export interface RegisterTelegramHitlApprovalInput {
  applicationSessionId: string;
  callbackData: readonly string[];
  eveSessionId: string;
  requestId: string;
  telegramChatId: string;
  telegramChatType: TelegramChatType;
  telegramMessageId: string;
  telegramMessageThreadId: string | null;
  telegramUserId: string;
}

export interface ClaimTelegramHitlCallbackInput {
  baseContinuationToken: string;
  callbackData: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId: string;
}

export interface AuthorizeTelegramHitlReplyInput {
  baseContinuationToken: string;
  telegramChatId: string;
  telegramMessageId: string;
  telegramUserId: string;
}

export type TelegramHitlCallbackClaim =
  | { auth: SessionAuthContext; continuationToken: string; status: "authorized" }
  | { status: "expired" | "forbidden" };
export type TelegramHitlReplyAuthorization =
  "authorized" | "expired" | "forbidden" | "not_applicable";

export interface TelegramHitlApprovalRepository {
  authorizeReply(input: AuthorizeTelegramHitlReplyInput): Promise<TelegramHitlReplyAuthorization>;
  claimCallback(input: ClaimTelegramHitlCallbackInput): Promise<TelegramHitlCallbackClaim>;
  clearForEveSession(applicationSessionId: string, eveSessionId: string): Promise<void>;
  hasPendingForSession(applicationSessionId: string, eveSessionId: string): Promise<boolean>;
  register(input: RegisterTelegramHitlApprovalInput): Promise<void>;
}

interface ApprovalRow {
  id: string;
  application_session_id: string;
  callback_data: string[];
  consumed_at: Date | null;
  continuation_token: string;
  eve_session_id: string;
  expected_telegram_user_id: string;
  family_id: string;
  group_id: string | null;
  owner_user_id: string | null;
  pending_operation: boolean;
  retired_at: Date | null;
  session_eve_session_id: string | null;
  scope: MemoryScope;
  telegram_chat_id: string;
  telegram_chat_type: TelegramChatType;
  telegram_message_id: string;
  telegram_message_thread_id: string | null;
}

interface IdentityRow {
  family_id: string;
  role: FamilyRole;
  user_id: string;
}

interface GroupRow {
  family_id: string;
  id: string;
  tool_allowlist: string[];
  type: GroupType;
}

async function lockApproval(
  client: PoolClient,
  telegramChatId: string,
  telegramMessageId: string,
): Promise<ApprovalRow | null> {
  const result = await client.query<ApprovalRow>(
    `SELECT a.application_session_id,
            a.callback_data,
            a.consumed_at,
            a.eve_session_id,
            a.expected_telegram_user_id,
            a.id,
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

async function findIdentity(
  client: PoolClient,
  telegramUserId: string,
  familyId: string,
): Promise<IdentityRow | null> {
  const result = await client.query<IdentityRow>(
    `SELECT fm.family_id, fm.role, fm.user_id
       FROM users u
       JOIN family_memberships fm ON fm.user_id = u.id
      WHERE u.telegram_user_id = $1
        AND fm.family_id = $2`,
    [telegramUserId, familyId],
  );
  return result.rows[0] ?? null;
}

async function currentCallbackAuth(
  client: PoolClient,
  row: ApprovalRow,
): Promise<SessionAuthContext | null> {
  const identity = await findIdentity(client, row.expected_telegram_user_id, row.family_id);
  let group: GroupRow | null = null;
  let memoryScopes: MemoryScope[];
  let role: FamilyRole | "external";
  let userId: string | null;

  // Personal approvals remain bound to the active owner and family membership of the session.
  if (row.scope === "personal") {
    if (
      !identity ||
      identity.user_id !== row.owner_user_id ||
      identity.family_id !== row.family_id ||
      row.telegram_chat_type !== "private"
    ) return null;
    memoryScopes = ["personal", "family"];
    role = identity.role;
    userId = identity.user_id;
  } else {
    const groupResult = await client.query<GroupRow>(
      `SELECT id, family_id, type, tool_allowlist
         FROM telegram_groups
        WHERE id = $1 AND telegram_chat_id = $2`,
      [row.group_id, row.telegram_chat_id],
    );
    group = groupResult.rows[0] ?? null;
    if (!group || group.family_id !== row.family_id || row.telegram_chat_type === "private") return null;

    // Family groups require current membership; external groups retain identity only for owners.
    const familyIdentity = identity?.family_id === group.family_id ? identity : null;
    if (group.type === "family_private") {
      if (!familyIdentity || row.scope !== "family") return null;
      memoryScopes = ["family"];
      role = familyIdentity.role;
      userId = familyIdentity.user_id;
    } else {
      if (row.scope !== "group") return null;
      memoryScopes = ["group"];
      role = familyIdentity?.role ?? "external";
      userId = familyIdentity?.user_id ?? null;
    }
  }

  // Only freshly read database policy enters the resumed Eve turn.
  return {
    attributes: {
      applicationSessionId: row.application_session_id,
      familyId: row.family_id,
      memoryScopes,
      role,
      telegramChatId: row.telegram_chat_id,
      telegramChatType: row.telegram_chat_type,
      telegramMessageId: row.telegram_message_id,
      ...(row.telegram_message_thread_id === null
        ? {}
        : { telegramMessageThreadId: row.telegram_message_thread_id }),
      telegramUserId: row.expected_telegram_user_id,
      ...(group ? { groupId: group.id, groupType: group.type } : {}),
      ...(group && group.type !== "family_private"
        ? { toolAllowlist: group.tool_allowlist }
        : {}),
    },
    authenticator: "telegram",
    principalId: userId ?? `telegram:${row.expected_telegram_user_id}`,
    principalType: "user",
  };
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
          telegram_message_thread_id, expected_telegram_user_id, callback_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (application_session_id, eve_session_id, request_id) DO UPDATE
         SET telegram_chat_id = EXCLUDED.telegram_chat_id,
             telegram_chat_type = EXCLUDED.telegram_chat_type,
             telegram_message_id = EXCLUDED.telegram_message_id,
             telegram_message_thread_id = EXCLUDED.telegram_message_thread_id,
             expected_telegram_user_id = EXCLUDED.expected_telegram_user_id,
             callback_data = EXCLUDED.callback_data,
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
      ],
    );
  },

  async claimCallback(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const row = await lockApproval(client, input.telegramChatId, input.telegramMessageId);
      if (
        !row ||
        !isPendingApproval(row) ||
        !row.callback_data.includes(input.callbackData)
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
      const auth = await currentCallbackAuth(client, row);
      if (!auth) {
        await client.query("ROLLBACK");
        return { status: "forbidden" };
      }
      const consumed = await client.query(
        `UPDATE telegram_hitl_approvals
            SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL`,
        [row.id],
      );
      if (consumed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      await client.query("COMMIT");
      return { auth, continuationToken: row.continuation_token, status: "authorized" };
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
      if (!isPendingApproval(row) || !routeMatches) {
        await client.query("ROLLBACK");
        return "expired";
      }
      if (row.expected_telegram_user_id !== input.telegramUserId) {
        await client.query("ROLLBACK");
        return "forbidden";
      }
      const consumed = await client.query(
        `UPDATE telegram_hitl_approvals
            SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL`,
        [row.id],
      );
      if (consumed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return "expired";
      }
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
