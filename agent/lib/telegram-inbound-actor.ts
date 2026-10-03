/**
 * Verified Telegram inbound actor projection.
 *
 * Exports:
 * - `TelegramInboundActor`: explicit user or channel identity derived before authorization.
 * - `TelegramTimelineActorKind`: persisted timeline actor discriminator.
 * - `telegramInboundActor`: fail-closed classifier for human, bot, and channel-authored messages.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

export type TelegramTimelineActorKind = "agent_self" | "telegram_bot" | "telegram_channel" | "user";
export type TelegramActorKind = "telegram_bot" | "telegram_channel" | "telegram_user";

export interface TelegramInboundActor {
  actorId: string;
  displayName: string | null;
  id: string;
  kind: TelegramActorKind;
  timelineKind: Exclude<TelegramTimelineActorKind, "agent_self">;
  username: string | null;
}

type JsonRecord = Record<string, unknown>;
// Telegram Bot API uses this fixed fake user for messages posted on behalf of a channel.
const TELEGRAM_CHANNEL_BOT_ID = "136817688";

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function exactIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return value;
  return null;
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function userDisplayName(message: TelegramMessage): string | null {
  const sender = message.from;
  if (!sender) return null;
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
  return name || sender.username || null;
}

export function telegramInboundActor(message: TelegramMessage): TelegramInboundActor | null {
  const sender = message.from;
  const senderChat = record(message.raw.sender_chat);

  // Human messages must not carry a second, conflicting visible Telegram sender.
  if (sender && !sender.isBot) {
    if (senderChat !== null) return null;
    return {
      actorId: `telegram:${sender.id}`,
      displayName: userDisplayName(message),
      id: sender.id,
      kind: "telegram_user",
      timelineKind: "user",
      username: sender.username ?? null,
    };
  }

  // Bot API 10.0 delivers another bot's group message once Bot-to-Bot Communication Mode is on.
  // A bot owns no application account, so it stays a visible Telegram identity like a channel.
  // Both identities must agree, and a second visible sender still means an anonymous or channel post.
  if (sender?.isBot === true && senderChat === null) {
    const rawSender = record(message.raw.from);
    if (!rawSender || rawSender.is_bot !== true || exactIdentifier(rawSender.id) !== sender.id ||
      !/^[1-9]\d*$/u.test(sender.id)) return null;
    return {
      actorId: `telegram-bot:${sender.id}`,
      displayName: userDisplayName(message),
      id: sender.id,
      kind: "telegram_bot",
      timelineKind: "telegram_bot",
      username: sender.username ?? null,
    };
  }

  // Telegram represents channel-authored supergroup posts as Channel_Bot plus raw sender_chat.
  // Both identities must agree with the verified webhook before the channel is trusted as actor.
  if (!sender?.isBot || !senderChat ||
    (message.chat.type !== "group" && message.chat.type !== "supergroup") ||
    senderChat.type !== "channel") return null;
  const rawSender = record(message.raw.from);
  const senderChatId = exactIdentifier(senderChat.id);
  const title = nonEmptyText(senderChat.title);
  if (!rawSender || sender.id !== TELEGRAM_CHANNEL_BOT_ID || rawSender.is_bot !== true ||
    exactIdentifier(rawSender.id) !== sender.id ||
    !senderChatId?.startsWith("-") || !title) return null;

  return {
    actorId: `telegram-channel:${senderChatId}`,
    displayName: title,
    id: senderChatId,
    kind: "telegram_channel",
    timelineKind: "telegram_channel",
    username: nonEmptyText(senderChat.username),
  };
}
