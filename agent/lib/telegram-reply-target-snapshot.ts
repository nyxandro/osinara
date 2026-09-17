/**
 * Verified nested Telegram reply-target projection.
 *
 * Exports:
 * - `TelegramReplyTargetSnapshot`: model-safe text and attribution for an unavailable reply target.
 * - `TelegramReplyTargetProjection`: everything one inbound message may say about its reply target.
 * - `telegramReplyTargetProjection`: verifies the target once, then projects its untrusted content.
 */
import type { TelegramMessage } from "eve/channels/telegram";

export interface TelegramReplyTargetSnapshot {
  contentText: string;
  senderDisplayName: string | null;
  senderUsername: string | null;
}

export interface TelegramReplyTargetProjection {
  /** Full target text, for a target the application cannot resolve from its own history. */
  snapshot: TelegramReplyTargetSnapshot | null;
  /** The fragment the author highlighted inside the target, when they highlighted one. */
  quotedText: string | null;
}

type JsonRecord = Record<string, unknown>;

type TelegramReplyMessage = Pick<TelegramMessage, "chat" | "raw" | "replyToMessage">;

const REJECTED_TARGET_CODE = "AGENT_TELEGRAM_REPLY_TARGET_REJECTED";

const NO_REPLY_TARGET: TelegramReplyTargetProjection = { snapshot: null, quotedText: null };

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function exactIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function senderProjection(target: JsonRecord): {
  senderDisplayName: string | null;
  senderUsername: string | null;
} {
  // Anonymous/channel posts carry the real visible author in sender_chat rather than from.
  const senderChat = record(target.sender_chat);
  const sender = senderChat ?? record(target.from);
  if (!sender) return { senderDisplayName: null, senderUsername: null };
  const senderUsername = nonEmptyText(sender.username);
  const senderDisplayName = senderChat
    ? nonEmptyText(sender.title) ?? senderUsername
    : [nonEmptyText(sender.first_name), nonEmptyText(sender.last_name)]
        .filter((part): part is string => part !== null)
        .join(" ") || senderUsername;
  return { senderDisplayName, senderUsername };
}

/**
 * A delivered reply always names a target of the same chat, so a refusal here means the transport
 * or the update changed shape. The turn continues without the target; the reason belongs in logs.
 */
function rejectTarget(
  reason: "foreign_chat" | "identity_mismatch",
  message: TelegramReplyMessage,
): null {
  console.error(JSON.stringify({
    code: REJECTED_TARGET_CODE,
    reason,
    telegramChatId: message.chat.id,
    telegramReplyTargetChatId: message.replyToMessage?.chat.id ?? null,
    telegramReplyTargetMessageId: message.replyToMessage?.messageId ?? null,
  }));
  return null;
}

/** Eve and raw Telegram identities must agree before nested untrusted content is admitted. */
function verifiedRawTarget(message: TelegramReplyMessage): JsonRecord | null {
  const parsedTarget = message.replyToMessage;
  const rawTarget = record(message.raw.reply_to_message);
  if (!parsedTarget || !rawTarget) return null;

  // The target must belong to the chat this turn was authorized for. Telegram delivers a reply to
  // another chat's message in `external_reply`, which never becomes `replyToMessage`, so the
  // application states the boundary itself instead of inheriting it from the transport.
  if (parsedTarget.chat.id !== message.chat.id) return rejectTarget("foreign_chat", message);

  const rawMessageId = exactIdentifier(rawTarget.message_id);
  const rawChatId = exactIdentifier(record(rawTarget.chat)?.id);
  if (rawMessageId !== parsedTarget.messageId || rawChatId !== parsedTarget.chat.id) {
    return rejectTarget("identity_mismatch", message);
  }
  return rawTarget;
}

function targetSnapshot(rawTarget: JsonRecord): TelegramReplyTargetSnapshot | null {
  const contentText = [nonEmptyText(rawTarget.text), nonEmptyText(rawTarget.caption)]
    .filter((part): part is string => part !== null)
    .join("\n");
  if (!contentText) return null;

  return { contentText, ...senderProjection(rawTarget) };
}

/**
 * Reads the reply target of one inbound message. Telegram sends `quote` when the author replied to
 * a selected fragment instead of the whole message; both the fragment and the full target text are
 * untrusted, so they are admitted only for a target this chat actually delivered, verified once.
 */
export function telegramReplyTargetProjection(
  message: TelegramReplyMessage,
): TelegramReplyTargetProjection {
  const rawTarget = verifiedRawTarget(message);
  if (!rawTarget) return NO_REPLY_TARGET;

  return {
    snapshot: targetSnapshot(rawTarget),
    quotedText: nonEmptyText(record(message.raw.quote)?.text),
  };
}
