/**
 * Telegram inbound dispatch policy.
 *
 * Exports:
 * - `TelegramInboundMediaKind`: strict none/photo/readable-text/unsupported-media decision.
 * - `classifyTelegramInboundMedia`: fail-closed classifier over raw and Eve-parsed media.
 * - `hasTelegramInboundMedia`: identifies file-bearing updates without downloading their bytes.
 * - `isAgentNameMentioned`: recognizes agent-name stems with any suffix at Unicode word boundaries.
 * - `isMessageAddressedToBot`: preserves private, mention, and reply behavior.
 * - `telegramGroupTurnTrigger`: names the technical signal that woke the agent in a group.
 * - `replyToAgentTrigger`: folds a journal-proven reply to the agent into that signal.
 * - `isTelegramSlashCommand`: identifies command-shaped text reserved for application handlers.
 * - `isReplyToBot`: verifies that a Telegram reply targets this exact bot identity.
 * - `TELEGRAM_EVE_UPLOAD_POLICY`: prevents direct file delivery to the text-only primary model.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { isTelegramImageDocumentCandidate } from "./attachments/telegram-vision-attachment.js";
import { isReadableTextDocumentCandidate } from "./attachments/attachment-policy.js";

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

/**
 * The mechanical reason a group message reached the agent. It describes how the trigger fired,
 * not whether the author addressed the agent: a bare name covers both "Осинара, посчитай" and
 * "Осинара вчера сказала", and only the model can tell those apart from the text.
 */
export type TelegramGroupTurnTrigger = "mention" | "name_in_text" | "reply_to_agent";

const TELEGRAM_COMMAND_PATTERN =
  /^\/[A-Za-z0-9_]{1,32}(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/u;
const TELEGRAM_MENTION_PATTERN = /(?:^|[^A-Za-z0-9_])@(?<target>[A-Za-z0-9_]+)/gu;
const AGENT_NAME_PATTERN =
  /(?:^|[^\p{L}\p{N}_])(?:осинар|асинар|азинар|озинар|синаар|osinar|asinar)\p{L}*(?=$|[^\p{L}\p{N}_])/iu;

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

export type TelegramInboundMediaKind =
  | "image_document_candidate"
  | "native_photo"
  | "none"
  | "text_document_candidate"
  | "unsupported_media";

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

export function classifyTelegramInboundMedia(
  message: Pick<TelegramMessage, "attachments" | "raw">,
): TelegramInboundMediaKind {
  const hasRawMedia = TELEGRAM_INBOUND_MEDIA_FIELDS.some(
    (field) => Object.hasOwn(message.raw, field),
  ) || TELEGRAM_CONDITIONAL_MEDIA_FIELDS.some(
    (field) => Object.hasOwn(message.raw, field) && containsTelegramFileReference(message.raw[field]),
  );
  if (message.attachments.length === 0 && !hasRawMedia) return "none";

  // The normalized attachment and raw Telegram shape must agree exactly. Documents remain only
  // candidates until downloaded magic bytes establish their authoritative image MIME.
  const rawPhoto = message.raw.photo;
  const hasOtherRawMedia = TELEGRAM_INBOUND_MEDIA_FIELDS.some(
    (field) => field !== "photo" && field !== "document" && Object.hasOwn(message.raw, field),
  ) || TELEGRAM_CONDITIONAL_MEDIA_FIELDS.some(
    (field) => Object.hasOwn(message.raw, field) && containsTelegramFileReference(message.raw[field]),
  );
  if (!hasOtherRawMedia && !Object.hasOwn(message.raw, "document") &&
    Array.isArray(rawPhoto) && rawPhoto.length > 0 &&
    message.attachments.length === 1 && message.attachments[0]?.kind === "photo") {
    const rawFileIds = new Set<string>();
    for (const size of rawPhoto) {
      if (!size || typeof size !== "object" || Array.isArray(size)) return "unsupported_media";
      const fileId = (size as Record<string, unknown>).file_id;
      if (typeof fileId !== "string" || fileId.length === 0) return "unsupported_media";
      rawFileIds.add(fileId);
    }
    return rawFileIds.has(message.attachments[0].fileId) ? "native_photo" : "unsupported_media";
  }

  const rawDocument = message.raw.document;
  const attachment = message.attachments[0];
  if (!hasOtherRawMedia && !Object.hasOwn(message.raw, "photo") &&
    rawDocument && typeof rawDocument === "object" && !Array.isArray(rawDocument) &&
    message.attachments.length === 1 && attachment?.kind === "document") {
    const raw = rawDocument as Record<string, unknown>;
    const exactFile = raw.file_id === attachment.fileId;
    const exactMime = raw.mime_type === undefined || raw.mime_type === attachment.mediaType;
    const exactName = raw.file_name === undefined || raw.file_name === attachment.fileName;
    const candidate = {
      ...attachment,
      ...(typeof raw.file_name === "string" ? { fileName: raw.file_name } : { fileName: undefined }),
      ...(typeof raw.mime_type === "string" ? { mediaType: raw.mime_type } : { mediaType: undefined }),
    };
    if (!exactFile || !exactMime || !exactName) return "unsupported_media";
    if (isTelegramImageDocumentCandidate(candidate)) return "image_document_candidate";
    if (isReadableTextDocumentCandidate(candidate)) return "text_document_candidate";
    return "unsupported_media";
  }
  return "unsupported_media";
}

export function hasTelegramInboundMedia(
  message: Pick<TelegramMessage, "attachments" | "raw">,
): boolean {
  return classifyTelegramInboundMedia(message) !== "none";
}

export function isReplyToBot(
  message: Pick<TelegramDispatchMessage, "replyToMessage">,
  botUsername: string,
): boolean {
  // Telegram's verified update identifies this bot exactly; another bot must never inherit its route.
  return Boolean(
    message.replyToMessage?.from?.isBot &&
      message.replyToMessage.from.username?.toLowerCase() === botUsername.toLowerCase(),
  );
}

export function isAgentNameMentioned(text: string): boolean {
  return AGENT_NAME_PATTERN.test(text);
}

export function isTelegramSlashCommand(text: string): boolean {
  return TELEGRAM_COMMAND_PATTERN.test(text);
}

export function telegramGroupTurnTrigger(
  message: TelegramDispatchMessage,
  botUsername: string,
): TelegramGroupTurnTrigger | null {
  // A private chat has no group trigger; a channel post and a slash command never wake the agent.
  if (message.chat.type === "private" || message.chat.type === "channel") return null;
  if (isTelegramSlashCommand(message.text)) return null;

  // Mentions and replies must target the complete username of this bot, not another bot.
  const addressedByMention = Array.from(message.text.matchAll(TELEGRAM_MENTION_PATTERN)).some(
    (match) => match.groups?.target?.toLowerCase() === botUsername.toLowerCase(),
  );
  if (addressedByMention) return "mention";
  if (isReplyToBot(message, botUsername)) return "reply_to_agent";
  return isAgentNameMentioned(message.text) ? "name_in_text" : null;
}

/** A reply to the agent is a deliberate signal and outranks a bare name; an explicit mention stays. */
export function replyToAgentTrigger(
  current: TelegramGroupTurnTrigger | null,
): TelegramGroupTurnTrigger {
  return current === "mention" ? "mention" : "reply_to_agent";
}

export function isMessageAddressedToBot(
  message: TelegramDispatchMessage,
  botUsername: string,
): boolean {
  // Private messages are direct by definition; every group trigger counts as an address.
  if (message.chat.type === "private") return true;
  return telegramGroupTurnTrigger(message, botUsername) !== null;
}
