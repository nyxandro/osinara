/**
 * The author's rights, checked again before every turn of a background task (#519).
 *
 * Export:
 * - `BackgroundTaskAccess`: what an ordinary turn of the task's chat would carry for its author now.
 * - `loadBackgroundTaskAccess`: reads it from the current records; null when the author lost access.
 * - `backgroundTaskAuth`: the trusted auth of the task's turn, marked as the task's.
 *
 * The auth mirrors an ordinary turn of the same chat (as a wake-up does), so the trust zone, the
 * folders and the memory scopes are the chat's, and adds the task mark that restricts the turn as a
 * delegated child. It carries no Telegram message or dispatch: nothing of the chat reaches the task.
 */
import type { SessionAuthContext } from "../../runtime/context.js";
import { database } from "../database.js";
import type { BackgroundTask } from "./background-task-records.js";
import { BACKGROUND_TASK_ID_ATTRIBUTE, BACKGROUND_TASK_SUMMARY_ATTRIBUTE } from "./background-task-session.js";

export interface BackgroundTaskAccess {
  readonly applicationConversationId: string;
  readonly role: "member" | "owner" | "recovery_owner";
  readonly skillAllowlist: readonly string[];
  readonly telegramUserId: string;
}

interface AccessRow {
  application_conversation_id: string | null;
  group_valid: boolean;
  role: BackgroundTaskAccess["role"] | null;
  skill_allowlist: string[] | null;
  telegram_user_id: string;
}

/**
 * The author is still a member of the task's family, and a group task's chat is still the family's
 * connected group. A private chat's family is the author's own: the record was written from that chat.
 */
export async function loadBackgroundTaskAccess(task: BackgroundTask): Promise<BackgroundTaskAccess | null> {
  const result = await database().query<AccessRow>(
    `SELECT users.telegram_user_id, membership.role, group_row.skill_allowlist,
            ($3::uuid IS NULL OR group_row.id IS NOT NULL) AS group_valid,
            conversation.id::text AS application_conversation_id
       FROM users
       LEFT JOIN family_memberships membership ON membership.family_id = $2 AND membership.user_id = users.id
       LEFT JOIN telegram_groups group_row
         ON group_row.id = $3 AND group_row.family_id = $2 AND group_row.telegram_chat_id = $4::text
        AND group_row.type = 'family_private' AND group_row.disconnected_at IS NULL
       LEFT JOIN application_conversations conversation ON conversation.telegram_chat_id = $4::text
      WHERE users.id = $1`,
    [task.authorUserId, task.familyId, task.groupId, task.telegramChatId],
  );
  const row = result.rows[0];
  if (!row || row.role === null || !row.group_valid || row.application_conversation_id === null) return null;
  return {
    applicationConversationId: row.application_conversation_id,
    role: row.role,
    skillAllowlist: row.skill_allowlist ?? [],
    telegramUserId: row.telegram_user_id,
  };
}

export function backgroundTaskAuth(input: {
  readonly access: BackgroundTaskAccess;
  readonly applicationSessionId: string;
  readonly now: Date;
  readonly summary: boolean;
  readonly task: BackgroundTask;
}): SessionAuthContext {
  const { access, task } = input;
  const family = task.groupId !== null;
  return {
    attributes: {
      applicationSessionId: input.applicationSessionId,
      [BACKGROUND_TASK_ID_ATTRIBUTE]: task.id,
      ...(input.summary ? { [BACKGROUND_TASK_SUMMARY_ATTRIBUTE]: "true" } : {}),
      familyId: task.familyId,
      ...(family ? { groupId: task.groupId!, groupType: "family_private" } : {}),
      memoryScopes: family ? ["family"] : ["personal", "family"],
      role: access.role,
      sandboxSessionId: task.sandboxSessionId,
      ...(family ? { skillAllowlist: [...access.skillAllowlist] } : {}),
      telegramActorId: access.telegramUserId,
      telegramActorKind: "telegram_user",
      telegramChatId: task.telegramChatId,
      telegramChatType: task.telegramChatType,
      telegramConversationId: access.applicationConversationId,
      ...(task.forumTopicId === null ? {} : { telegramForumTopicId: task.forumTopicId }),
      ...(task.messageThreadId === null ? {} : { telegramMessageThreadId: task.messageThreadId }),
      telegramTurnStartedAt: input.now.toISOString(),
      telegramUserId: access.telegramUserId,
    },
    authenticator: "telegram",
    principalId: task.authorUserId,
    principalType: "user",
  };
}
