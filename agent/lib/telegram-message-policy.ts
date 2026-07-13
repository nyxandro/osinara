/**
 * Telegram inbound dispatch policy.
 *
 * Exports:
 * - `hasTelegramInboundMedia`: identifies file-bearing updates without downloading their bytes.
 * - `isMessageAddressedToBot`: preserves private, command, mention, and reply behavior.
 * - `TELEGRAM_EVE_UPLOAD_POLICY`: prevents direct file delivery to the text-only primary model.
 */
import type { TelegramMessage } from "eve/channels/telegram";

interface TelegramDispatchMessage {
  chat: {
    id?: string;
    type: "channel" | "group" | "private" | "supergroup";
  };
  replyToMessage?: {
    from?: {
      id?: string;
      isBot: boolean;
      username?: string;
    };
  };
  text: string;
}

const TELEGRAM_COMMAND_PATTERN =
  /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u;
const TELEGRAM_MENTION_PATTERN = /(?:^|[^A-Za-z0-9_])@(?<target>[A-Za-z0-9_]+)/gu;

// The application persists authorized files and exposes trusted workspace paths. Eve must not
// forward a second copy to the text-only primary model; vision runs through the dedicated tool.
export const TELEGRAM_EVE_UPLOAD_POLICY = "disabled" as const;

const TELEGRAM_INBOUND_MEDIA_FIELDS = [
  "animation",
  "audio",
  "document",
  "game",
  "gift",
  "live_photo",
  "new_chat_photo",
  "paid_media",
  "passport_data",
  "photo",
  "sticker",
  "story",
  "unique_gift",
  "video",
  "video_note",
  "voice",
] as const;
const TELEGRAM_CONDITIONAL_MEDIA_FIELDS = [
  "chat_shared",
  "poll",
  "rich_message",
  "users_shared",
] as const;

function containsTelegramFileReference(value: unknown): boolean {
  // Conditional structures can be text-only, so search only their own subtree for actual files.
  const pending = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.file_id === "string" && record.file_id.length > 0) return true;
    pending.push(...Object.values(record));
  }
  return false;
}

export function hasTelegramInboundMedia(
  message: Pick<TelegramMessage, "attachments" | "raw">,
): boolean {
  // Raw fields cover media kinds Eve does not expose as attachments, notably voice and video.
  if (message.attachments.length > 0) return true;
  if (TELEGRAM_INBOUND_MEDIA_FIELDS.some((field) => Object.hasOwn(message.raw, field))) return true;
  return TELEGRAM_CONDITIONAL_MEDIA_FIELDS.some(
    (field) => Object.hasOwn(message.raw, field) && containsTelegramFileReference(message.raw[field]),
  );
}

export function isMessageAddressedToBot(
  message: TelegramDispatchMessage,
  botUsername: string,
): boolean {
  // Private messages are direct by definition; channels never dispatch to the agent.
  if (message.chat.type === "private") return true;
  if (message.chat.type === "channel") return false;

  // Telegram commands start at the first character; an explicit suffix must name this bot.
  const commandMatch = TELEGRAM_COMMAND_PATTERN.exec(message.text);
  const commandTarget = commandMatch?.groups?.target;
  if (commandMatch && (!commandTarget || commandTarget.toLowerCase() === botUsername.toLowerCase())) {
    return true;
  }

  // Mentions and replies must target the complete username of this bot, not another bot.
  const addressedByMention = Array.from(message.text.matchAll(TELEGRAM_MENTION_PATTERN)).some(
    (match) => match.groups?.target?.toLowerCase() === botUsername.toLowerCase(),
  );
  if (addressedByMention) return true;
  return Boolean(
    message.replyToMessage?.from?.isBot &&
      message.replyToMessage.from.username?.toLowerCase() === botUsername.toLowerCase(),
  );
}
