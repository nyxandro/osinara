/**
 * Recognition of a private question: an ephemeral command in a group (#467, Bot API 10.2–10.3).
 *
 * Exports:
 * - `PrivateQuestionMessage`: what the application keeps of the incoming ephemeral command.
 * - `isEphemeralGroupMessage`: whether an update is an ephemeral message of a group, whatever it says.
 * - `parsePrivateQuestion`: the asker, chat, topic, the ephemeral message to reply to and the question.
 *
 * Key constructs:
 * - Telegram delivers an ephemeral command as an ordinary `message` with `message_id` 0 and its own
 *   `ephemeral_message_id` (seen on the production bot on 2026-11-06). Anything carrying that id must stay
 *   out of the group's shared timeline, so recognition does not depend on which command it is.
 * - The menu inserts `/me@<bot>`; the question is the text after the leading command entity.
 */
import { isObject } from "../../runtime/json.js";

export interface PrivateQuestionMessage {
  readonly chatId: string;
  /** The command the person sent, lower-cased, without the bot's username: `me` for the menu's command. */
  readonly command: string;
  readonly firstName: string;
  readonly incomingEphemeralMessageId: number;
  /** Empty when the person sent the command alone. */
  readonly question: string;
  /** Unix seconds of the command, as Telegram stamped it. */
  readonly sentAt: number;
  readonly telegramUserId: string;
  readonly threadId: number | null;
}

const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);

function ephemeralId(message: Record<string, unknown>): number | null {
  const value = message.ephemeral_message_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isEphemeralGroupMessage(raw: unknown): boolean {
  if (!isObject(raw) || !isObject(raw.message)) return false;
  const chat = raw.message.chat;
  return ephemeralId(raw.message) !== null && isObject(chat) && GROUP_CHAT_TYPES.has(String(chat.type));
}

/** Returns null for anything that is not an ephemeral command a person sent in a group. */
export function parsePrivateQuestion(raw: unknown): PrivateQuestionMessage | null {
  if (!isEphemeralGroupMessage(raw)) return null;
  const message = (raw as { message: Record<string, unknown> }).message;
  const chat = message.chat as Record<string, unknown>;
  const from = message.from;
  if (!isObject(from) || from.is_bot === true || typeof from.id !== "number") return null;
  if (typeof chat.id !== "number" && typeof chat.id !== "string") return null;
  if (typeof message.date !== "number") return null;
  const text = typeof message.text === "string" ? message.text : "";
  const entities = Array.isArray(message.entities) ? message.entities : [];
  const commandEntity = entities.find((entity) =>
    isObject(entity) && entity.type === "bot_command" && entity.offset === 0 && typeof entity.length === "number");
  if (!isObject(commandEntity)) return null;
  const commandText = text.slice(0, commandEntity.length as number);
  const command = commandText.slice(1).split("@")[0]!.toLowerCase();
  const thread = message.message_thread_id;
  return {
    chatId: String(chat.id),
    command,
    firstName: typeof from.first_name === "string" && from.first_name.length > 0 ? from.first_name : String(from.id),
    incomingEphemeralMessageId: ephemeralId(message)!,
    question: text.slice(commandText.length).trim(),
    sentAt: message.date,
    telegramUserId: String(from.id),
    threadId: message.is_topic_message === true && typeof thread === "number" ? thread : null,
  };
}
