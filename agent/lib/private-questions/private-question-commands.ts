/**
 * The bot's `/me` command menu in group chats (#467, docs/plans/private-questions.md).
 *
 * Exports:
 * - `PRIVATE_QUESTION_COMMAND`: the one ephemeral command of the menu.
 * - `PrivateQuestionCommandScope`, `desiredPrivateQuestionCommandScopes`: which menus the registered groups need.
 * - `createPrivateQuestionCommandSync`: reconciles Telegram with the desired menus under one database lock.
 * - `syncPrivateQuestionCommands`: the production reconciliation; a failure becomes one owner incident and
 *   never fails the action that asked for it.
 *
 * Key constructs:
 * - The menu is set per chat, never for all groups at once, so `/me` shows only where the bot works: in a
 *   connected family or external group; in an external group that answers only the owner, only to the owner.
 * - What was set is remembered in `telegram_private_question_command_scopes`, so the menu of a group that is
 *   no longer in the database is still taken down.
 * - Telegram answering that the chat is gone or the bot is not in it counts as taken down.
 */
import type { PoolClient } from "pg";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { callTelegramApi, type TelegramApiResponse } from "../../runtime/telegram/api.js";
import { database } from "../database.js";
import { recordOperationalIncident } from "../operational-incidents/owner-alerts.js";

export const PRIVATE_QUESTION_COMMAND = Object.freeze({
  command: "me",
  description: "Спросить лично: ответ увидишь только ты",
  is_ephemeral: true,
});

// One reconciliation at a time: two owner actions in a row must not interleave their Telegram calls.
const COMMAND_SYNC_LOCK_KEY = 467_001;
// Telegram refuses a call about a chat the bot has left or that no longer exists with one of these.
const GONE_HTTP_STATUSES = new Set([400, 403]);

export interface PrivateQuestionCommandScope {
  readonly scope: "chat" | "chat_member";
  readonly telegramChatId: string;
  readonly telegramUserId: string | null;
}

export interface PrivateQuestionCommandGroup {
  readonly connected: boolean;
  readonly messageMode: string;
  readonly ownerTelegramUserId: string;
  readonly telegramChatId: string;
  readonly type: "external" | "family_private";
}

export function desiredPrivateQuestionCommandScopes(
  groups: readonly PrivateQuestionCommandGroup[],
): PrivateQuestionCommandScope[] {
  return groups
    .filter((group) => group.connected)
    .map((group) => group.type === "external" && group.messageMode === "owner_only"
      ? { scope: "chat_member" as const, telegramChatId: group.telegramChatId, telegramUserId: group.ownerTelegramUserId }
      : { scope: "chat" as const, telegramChatId: group.telegramChatId, telegramUserId: null });
}

function scopeKey(scope: PrivateQuestionCommandScope): string {
  return `${scope.telegramChatId}|${scope.scope}|${scope.telegramUserId ?? ""}`;
}

function telegramScope(scope: PrivateQuestionCommandScope): Record<string, string> {
  return scope.scope === "chat"
    ? { chat_id: scope.telegramChatId, type: "chat" }
    : { chat_id: scope.telegramChatId, type: "chat_member", user_id: scope.telegramUserId! };
}

export interface PrivateQuestionCommandSyncDependencies {
  /** Runs `work` inside one transaction that holds the reconciliation lock. */
  withLock<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  telegram(method: "deleteMyCommands" | "setMyCommands", body: Record<string, unknown>): Promise<TelegramApiResponse>;
}

export interface PrivateQuestionCommandSyncResult {
  readonly failed: readonly { readonly code: string; readonly scope: PrivateQuestionCommandScope; readonly status: number }[];
  readonly removed: number;
  readonly set: number;
}

async function loadGroups(client: PoolClient): Promise<PrivateQuestionCommandGroup[]> {
  const result = await client.query<{
    connected: boolean; message_mode: string; owner_telegram_user_id: string; telegram_chat_id: string;
    type: "external" | "family_private";
  }>(
    `SELECT groups.telegram_chat_id, groups.type::text AS type, groups.message_mode::text AS message_mode,
            groups.disconnected_at IS NULL AS connected, owners.telegram_user_id AS owner_telegram_user_id
       FROM telegram_groups AS groups
       JOIN family_memberships AS membership ON membership.family_id = groups.family_id AND membership.role = 'owner'
       JOIN users AS owners ON owners.id = membership.user_id`,
  );
  return result.rows.map((row) => ({
    connected: row.connected,
    messageMode: row.message_mode,
    ownerTelegramUserId: row.owner_telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    type: row.type,
  }));
}

async function loadSetScopes(client: PoolClient): Promise<PrivateQuestionCommandScope[]> {
  const result = await client.query<{ scope: "chat" | "chat_member"; telegram_chat_id: string; telegram_user_id: string | null }>(
    "SELECT telegram_chat_id, scope, telegram_user_id FROM telegram_private_question_command_scopes",
  );
  return result.rows.map((row) => ({ scope: row.scope, telegramChatId: row.telegram_chat_id, telegramUserId: row.telegram_user_id }));
}

export function createPrivateQuestionCommandSync(dependencies: PrivateQuestionCommandSyncDependencies) {
  return async function reconcile(): Promise<PrivateQuestionCommandSyncResult> {
    return await dependencies.withLock(async (client) => {
      const desired = desiredPrivateQuestionCommandScopes(await loadGroups(client));
      const desiredKeys = new Set(desired.map(scopeKey));
      const failed: { code: string; scope: PrivateQuestionCommandScope; status: number }[] = [];
      let set = 0;
      let removed = 0;
      // Taking down first: a group switched to "only the owner" must lose its chat-wide menu.
      for (const scope of await loadSetScopes(client)) {
        if (desiredKeys.has(scopeKey(scope))) continue;
        const response = await dependencies.telegram("deleteMyCommands", { scope: telegramScope(scope) });
        if (!response.ok && !GONE_HTTP_STATUSES.has(response.status)) {
          failed.push({ code: "deleteMyCommands", scope, status: response.status });
          continue;
        }
        await client.query(
          `DELETE FROM telegram_private_question_command_scopes
            WHERE telegram_chat_id = $1 AND scope = $2 AND telegram_user_id IS NOT DISTINCT FROM $3`,
          [scope.telegramChatId, scope.scope, scope.telegramUserId],
        );
        removed += 1;
      }
      // Setting is idempotent in Telegram, so every desired menu is written again: a menu changed by hand in
      // BotFather comes back to the application's.
      for (const scope of desired) {
        const response = await dependencies.telegram("setMyCommands", {
          commands: [PRIVATE_QUESTION_COMMAND],
          scope: telegramScope(scope),
        });
        if (!response.ok) {
          failed.push({ code: "setMyCommands", scope, status: response.status });
          continue;
        }
        await client.query(
          `INSERT INTO telegram_private_question_command_scopes (telegram_chat_id, scope, telegram_user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (telegram_chat_id, scope, telegram_user_id) DO UPDATE SET set_at = now()`,
          [scope.telegramChatId, scope.scope, scope.telegramUserId],
        );
        set += 1;
      }
      return { failed, removed, set };
    });
  };
}

const productionReconcile = createPrivateQuestionCommandSync({
  async withLock(work) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_SYNC_LOCK_KEY]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  telegram: (method, body) => callTelegramApi({
    body: body as Parameters<typeof callTelegramApi>[0]["body"],
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
    method,
  }),
});

/**
 * Brings the menus in line with the groups; called at startup and after every change of a group. The change
 * itself has already happened, so a Telegram failure is reported to the owner and retried by the next sync.
 */
export async function syncPrivateQuestionCommands(reason: string): Promise<void> {
  let failure: { readonly context: Record<string, string>; readonly key: string; readonly summary: string } | null = null;
  try {
    const result = await productionReconcile();
    console.info(JSON.stringify({
      code: "AGENT_PRIVATE_QUESTION_COMMANDS_SYNCED", failed: result.failed.length, reason, removed: result.removed, set: result.set,
    }));
    if (result.failed.length > 0) {
      failure = {
        context: {
          failed: result.failed.map((item) => `${item.code} ${item.scope.telegramChatId} HTTP ${item.status}`).join("; "),
          reason,
        },
        // One incident per set of failing chats, not one per startup or group change.
        key: `private-question-commands:${result.failed.map((item) => item.scope.telegramChatId).sort().join(",")}`,
        summary: "Не удалось обновить команду /me в меню некоторых групп. Повторю при следующем запуске или изменении группы.",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ code: "AGENT_PRIVATE_QUESTION_COMMANDS_SYNC_FAILED", error: message, reason }));
    failure = {
      context: { error: message, reason },
      key: "private-question-commands:error",
      summary: "Не удалось обновить команду /me в меню групп. Повторю при следующем запуске или изменении группы.",
    };
  }
  if (failure === null) return;
  try {
    await recordOperationalIncident({
      key: failure.key,
      code: "AGENT_PRIVATE_QUESTION_COMMANDS_SYNC_FAILED",
      summary: failure.summary,
      context: failure.context,
    });
  } catch (error) {
    // The group change itself succeeded; the failure is already in the log above.
    console.error(JSON.stringify({
      code: "AGENT_PRIVATE_QUESTION_COMMANDS_INCIDENT_FAILED", error: error instanceof Error ? error.message : String(error), reason,
    }));
  }
}
