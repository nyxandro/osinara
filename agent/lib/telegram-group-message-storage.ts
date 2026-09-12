/**
 * Shared Telegram group message persistence primitives.
 *
 * Exports:
 * - Message field normalizers for trusted PostgreSQL writes.
 * - `telegramInboundText`: readable text of a message, including native rich formatting.
 * - `telegramForumTopicId`: verified forum topic isolation separate from reply routing.
 * - `lockTelegramGroupJournal` and `pruneTelegramGroupJournal` transaction helpers.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import type { PoolClient } from "pg";

import { TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES } from "../config.js";
import { memoryContentRejectionCode } from "./memory-content-policy.js";
import { telegramRichMessageText } from "./telegram-rich-inbound.js";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MILLISECONDS_PER_SECOND = 1_000;

export function requireTelegramPositiveBigint(value: string, field: string): string {
  if (!/^[1-9]\d*$/u.test(value) || BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new Error(
      `AGENT_TELEGRAM_MESSAGE_INVALID: Telegram передал некорректное поле ${field}`,
    );
  }
  return value;
}

export function telegramMessageThreadId(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram передал некорректный идентификатор темы",
    );
  }
  return String(value);
}

export function telegramForumTopicId(
  message: Pick<TelegramMessage, "messageThreadId" | "raw">,
): string | null {
  // Telegram also assigns message_thread_id to ordinary reply branches. Only this explicit
  // Bot API flag proves that the ID denotes a forum topic and therefore a separate data context.
  if (message.raw.is_topic_message !== true) return null;
  if (message.messageThreadId === undefined) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал идентификатор форумной темы",
    );
  }
  return telegramMessageThreadId(message.messageThreadId);
}

export function telegramMessageSentAt(message: TelegramMessage): Date {
  const unixSeconds = message.raw.date;
  if (!Number.isSafeInteger(unixSeconds) || Number(unixSeconds) < 0) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал корректное время сообщения",
    );
  }
  const date = new Date(Number(unixSeconds) * MILLISECONDS_PER_SECOND);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал корректное время сообщения",
    );
  }
  return date;
}

export function telegramMessageKind(message: TelegramMessage): string {
  // Media keys survive Eve parsing in `raw`; only the compact kind is persisted.
  for (const kind of [
    "voice",
    "audio",
    "video",
    "video_note",
    "sticker",
    "animation",
    "contact",
    "location",
    "venue",
    "poll",
    "dice",
    "game",
  ]) {
    if (message.raw[kind] !== undefined) return kind;
  }
  if (message.attachments.some((attachment) => attachment.kind === "photo")) return "photo";
  if (message.attachments.some((attachment) => attachment.kind === "document")) return "document";
  if (telegramInboundText(message)) return "text";
  return "other";
}

/**
 * A rich message carries its content in `rich_message` and arrives with no `text` or `caption`,
 * so reading only those fields loses the message entirely.
 */
export function telegramInboundText(
  message: Pick<TelegramMessage, "caption" | "raw" | "text">,
): string {
  return [message.text, message.caption, telegramRichMessageText(message.raw.rich_message)]
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function telegramMessageContent(message: TelegramMessage): string | null {
  const content = telegramInboundText(message);
  if (!content || memoryContentRejectionCode(content)) return null;
  return content;
}

export function telegramSenderDisplayName(message: TelegramMessage): string | null {
  const sender = message.from;
  if (!sender) return null;
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function lockTelegramGroupJournal(
  client: PoolClient,
  groupId: string,
): Promise<void> {
  // Group compatibility writers share the application-conversation lock with snapshots/catch-up.
  const conversation = await client.query<{ id: string }>(
    "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
    [groupId],
  );
  const conversationId = conversation.rows[0]?.id;
  if (!conversationId) {
    throw new Error("AGENT_APPLICATION_CONVERSATION_NOT_FOUND: Для группы не найден разговор");
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationId]);
}

export async function pruneTelegramGroupJournal(
  client: PoolClient,
  groupId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM telegram_group_messages
     WHERE id IN (
       SELECT id FROM telegram_group_messages
       WHERE group_id = $1
       ORDER BY sequence_id DESC
       OFFSET $2
        ) AND NOT EXISTS (
          SELECT 1 FROM memory_review_batch_sources AS source
          WHERE source.timeline_entry_id = telegram_group_messages.id
        ) AND NOT EXISTS (
          SELECT 1 FROM memory_turn_sources AS source
          WHERE source.timeline_entry_id = telegram_group_messages.id
        ) AND NOT EXISTS (
          SELECT 1 FROM memory_review_lanes AS lane
          WHERE lane.conversation_id = telegram_group_messages.conversation_id
            AND lane.message_thread_id IS NOT DISTINCT FROM telegram_group_messages.message_thread_id
            AND telegram_group_messages.actor_kind IN ('user', 'telegram_bot')
            AND telegram_group_messages.sequence_id > lane.processed_through_sequence
        )`,
    [groupId, TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES],
  );
}
