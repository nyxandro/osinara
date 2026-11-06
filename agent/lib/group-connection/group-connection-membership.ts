/**
 * Telegram's news that the bot left or rejoined a group: `my_chat_member` (#465).
 *
 * Exports:
 * - `BotMembershipDependencies`: the state change, the owner's chat, keys, sandboxes and Telegram.
 * - `createBotMembershipHandler`: handles one `my_chat_member` update.
 * - `handleBotMembershipUpdate`: the production handler the webhook calls.
 *
 * Key constructs:
 * - A group's administrator removing the bot disconnects a connected external group, as if the owner
 *   had: nothing is read, recorded or answered there, its reminders and schedules stand still, and the
 *   owner is told once. The bot added back only tells the owner; reconnection stays the owner's call.
 * - The state change is idempotent and ordered by the event's own time, so a redelivered or late event
 *   tells no one twice. It is recorded before Telegram gets its answer; keys, sandboxes and the owner's
 *   message follow in the background, and a failure there never undoes the change.
 * - Only groups count: in a private chat the same update means a person blocked the bot.
 */
import { isObject } from "../../runtime/json.js";
import { apiKeyPublisher } from "../api-keys/api-key-projection.js";
import { database } from "../database.js";
import { stopGroupSandboxes } from "../telegram-group-policy-repository.js";
import { syncPrivateQuestionCommands } from "../private-questions/private-question-commands.js";
import { groupConnectionRepository } from "./group-connection-repository.js";
import { botRejoinedNotice, botRemovedNotice, groupConnectionTelegram } from "./group-connection-telegram.js";

// Statuses in which the bot is in the chat; `restricted` counts only with `is_member`.
const MEMBER_STATUSES = new Set(["administrator", "creator", "member"]);
const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

export interface BotMembershipDependencies {
  ownerTelegramChatId(familyId: string): Promise<string>;
  publishApiKeys(): Promise<void>;
  recordBotMembership: typeof groupConnectionRepository.recordBotMembership;
  sendToOwner(ownerTelegramChatId: string, text: string): Promise<void>;
  stopSandboxes(groupId: string): Promise<void>;
  /** Brings the `/me` menu in line with the groups (#467); never rejects. */
  syncCommands(reason: string): Promise<void>;
}

interface BotMembershipEvent {
  changedAt: Date;
  member: boolean;
  telegramChatId: string;
}

function parseEvent(update: unknown): BotMembershipEvent | null {
  if (!isObject(update) || !isObject(update.chat) || !isObject(update.new_chat_member)) return null;
  const { chat, date, new_chat_member: member } = update;
  if (typeof chat.type !== "string" || !GROUP_CHAT_TYPES.has(chat.type)) return null;
  if (typeof chat.id !== "number" && typeof chat.id !== "string") return null;
  if (typeof date !== "number" || !Number.isFinite(date) || typeof member.status !== "string") return null;
  return {
    changedAt: new Date(date * 1000),
    member: MEMBER_STATUSES.has(member.status) || (member.status === "restricted" && member.is_member === true),
    telegramChatId: String(chat.id),
  };
}

function logged(code: string, error: unknown, groupId: string): void {
  console.error(JSON.stringify({ code, error: error instanceof Error ? error.message : String(error), groupId }));
}

export function createBotMembershipHandler(dependencies: BotMembershipDependencies) {
  const tellOwner = async (familyId: string, text: string, groupId: string): Promise<void> => {
    try {
      await dependencies.sendToOwner(await dependencies.ownerTelegramChatId(familyId), text);
    } catch (error) {
      logged("AGENT_GROUP_CONNECTION_NOTICE_FAILED", error, groupId);
    }
  };

  const afterRemoval = async (familyId: string, groupId: string, title: string): Promise<void> => {
    try {
      await dependencies.publishApiKeys();
    } catch (error) {
      logged("AGENT_API_KEY_PUBLISH_FAILED", error, groupId);
    }
    try {
      await dependencies.stopSandboxes(groupId);
    } catch (error) {
      logged("AGENT_GROUP_SANDBOX_STOP_FAILED", error, groupId);
    }
    await tellOwner(familyId, botRemovedNotice(title), groupId);
  };

  return async function handleBotMembership(update: unknown, waitUntil: (work: Promise<unknown>) => void): Promise<void> {
    const event = parseEvent(update);
    if (event === null) return;
    const result = await dependencies.recordBotMembership(event);
    if (result.change === "none") return;
    console.info(JSON.stringify({ change: result.change, code: "AGENT_GROUP_BOT_MEMBERSHIP_CHANGED", groupId: result.groupId }));
    waitUntil(dependencies.syncCommands("bot_membership"));
    if (result.change === "rejoined_while_disconnected") {
      waitUntil(tellOwner(result.familyId, botRejoinedNotice(result.title), result.groupId));
      return;
    }
    console.info(JSON.stringify({ code: "AGENT_GROUP_DISCONNECTED", groupId: result.groupId, reason: "bot_removed" }));
    waitUntil(afterRemoval(result.familyId, result.groupId, result.title));
  };
}

async function ownerTelegramChatId(familyId: string): Promise<string> {
  const result = await database().query<{ telegram_user_id: string }>(
    `SELECT users.telegram_user_id FROM family_memberships AS membership
       JOIN users ON users.id = membership.user_id
      WHERE membership.family_id = $1 AND membership.role = 'owner'`,
    [familyId],
  );
  const owner = result.rows[0];
  if (!owner) throw new Error(`AGENT_FAMILY_OWNER_MISSING: family ${familyId} has no owner to tell`);
  return owner.telegram_user_id;
}

export const handleBotMembershipUpdate = createBotMembershipHandler({
  ownerTelegramChatId,
  publishApiKeys: () => apiKeyPublisher.publish(),
  recordBotMembership: (input) => groupConnectionRepository.recordBotMembership(input),
  sendToOwner: (chatId, text) => groupConnectionTelegram.sendToOwner(chatId, text),
  syncCommands: (reason) => syncPrivateQuestionCommands(reason),
  async stopSandboxes(groupId) {
    const client = await database().connect();
    try {
      await stopGroupSandboxes(client, groupId);
    } finally {
      client.release();
    }
  },
});
