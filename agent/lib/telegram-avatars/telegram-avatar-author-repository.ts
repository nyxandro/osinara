/**
 * The author of a message of the current chat, for a look at their avatar.
 *
 * Exports:
 * - `TelegramAvatarAuthor`: who wrote the message, by Telegram id and kind.
 * - `telegramAvatarAuthorRepository`: finds the author by the message number the model sees.
 *
 * Key constructs:
 * - The chat comes from the verified workspace authorization, not from the model: the private chat
 *   of the user, or the registered group. A message number is unique only inside one chat, so the
 *   same number elsewhere is never reached.
 * - Live access to the chat is the caller's check (`authorizeScope`) and runs before this lookup.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";

export interface TelegramAvatarAuthor {
  actorKind: "agent_self" | "telegram_bot" | "telegram_channel" | "user";
  senderDisplayName: string | null;
  senderUsername: string | null;
  telegramUserId: string | null;
}

interface AuthorRow {
  actor_kind: TelegramAvatarAuthor["actorKind"];
  sender_display_name: string | null;
  sender_username: string | null;
  telegram_user_id: string | null;
}

const MESSAGE_NUMBER_PATTERN = /^\d+$/u;

function chatOf(auth: WorkspaceAuthorization): { groupId: string; userId: null } | { groupId: null; userId: string } {
  if (auth.telegramChatType === "private" && auth.groupId === null && auth.userId !== null) {
    return { groupId: null, userId: auth.userId };
  }
  if (auth.telegramChatType !== "private" && auth.groupId !== null && auth.groupType !== null) {
    return { groupId: auth.groupId, userId: null };
  }
  throw new AppError("AGENT_TELEGRAM_AVATAR_CONTEXT_INVALID", "Аватарки доступны только внутри проверенного чата");
}

export const telegramAvatarAuthorRepository = {
  async find(auth: WorkspaceAuthorization, sequenceId: string): Promise<TelegramAvatarAuthor | null> {
    if (!MESSAGE_NUMBER_PATTERN.test(sequenceId)) {
      throw new AppError("AGENT_TELEGRAM_AVATAR_SOURCE_INVALID", "Номер сообщения должен состоять из цифр");
    }
    const chat = chatOf(auth);
    const result = await database().query<AuthorRow>(
      `SELECT message.actor_kind, message.telegram_user_id, message.sender_username, message.sender_display_name
       FROM application_conversations AS conversation
       JOIN telegram_group_messages AS message ON message.conversation_id = conversation.id
       WHERE conversation.family_id = $1
         AND CASE WHEN $2::uuid IS NULL
               THEN conversation.scope = 'personal' AND conversation.owner_user_id = $3::uuid
               ELSE conversation.telegram_group_id = $2::uuid
             END
         AND message.sequence_id = $4::bigint`,
      [auth.familyId, chat.groupId, chat.userId, sequenceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      actorKind: row.actor_kind,
      senderDisplayName: row.sender_display_name,
      senderUsername: row.sender_username,
      telegramUserId: row.telegram_user_id,
    };
  },
};
