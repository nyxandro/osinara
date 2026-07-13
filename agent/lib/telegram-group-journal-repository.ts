/**
 * PostgreSQL Telegram group journal repository.
 *
 * Exports:
 * - `TelegramGroupJournalRepository`: injectable record/context lookup contract.
 * - `telegramGroupJournalRepository`: normalized, deduplicated, retention-bounded journal.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import type { PoolClient } from "pg";

import {
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
  TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES,
} from "../config.js";
import { database } from "./database.js";
import type { TelegramGroupJournalEntry } from "./telegram-group-journal-context.js";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MILLISECONDS_PER_SECOND = 1_000;

interface ListJournalInput {
  beforeTelegramMessageId: string;
  groupId: string;
  limit: number;
  messageThreadId: string | null;
}

export interface TelegramGroupJournalRepository {
  listBefore(input: ListJournalInput): Promise<TelegramGroupJournalEntry[]>;
  record(
    groupId: string,
    message: TelegramMessage,
  ): Promise<"duplicate" | "inserted" | "mode_disabled">;
}

interface JournalRow {
  content_text: string | null;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_message_id: string | null;
  sender_display_name: string | null;
  sender_is_bot: boolean;
  sender_username: string | null;
  sent_at: Date;
  telegram_message_id: string;
  telegram_user_id: string | null;
}

function requirePositiveBigint(value: string, field: string): string {
  if (!/^[1-9]\d*$/u.test(value) || BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new Error(
      `AGENT_TELEGRAM_MESSAGE_INVALID: Telegram передал некорректное поле ${field}`,
    );
  }
  return value;
}

function optionalThreadId(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram передал некорректный идентификатор темы",
    );
  }
  return String(value);
}

function sentAt(message: TelegramMessage): Date {
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

function messageKind(message: TelegramMessage): string {
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
  if (message.text || message.caption) return "text";
  return "other";
}

function contentText(message: TelegramMessage): string | null {
  const content = [message.text, message.caption].filter(Boolean).join("\n").trim();
  return content || null;
}

function displayName(message: TelegramMessage): string | null {
  const sender = message.from;
  if (!sender) return null;
  const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

async function lockGroup(client: PoolClient, groupId: string): Promise<void> {
  // One transaction per group owns insertion and pruning, preventing concurrent cap overruns.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [groupId]);
}

export const telegramGroupJournalRepository: TelegramGroupJournalRepository = {
  async record(groupId, message) {
    const messageId = requirePositiveBigint(message.messageId, "message_id");
    const threadId = optionalThreadId(message.messageThreadId);
    const replyToMessageId = message.replyToMessage
      ? requirePositiveBigint(message.replyToMessage.messageId, "reply_to_message_id")
      : null;
    const sender = message.from;
    if (!sender) {
      throw new Error(
        "AGENT_TELEGRAM_MESSAGE_INVALID: Telegram не передал отправителя группового сообщения",
      );
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockGroup(client, groupId);

      // ON CONFLICT is the webhook idempotency boundary and never mutates the first delivery.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (group_id, telegram_message_id, message_thread_id, telegram_user_id,
            sender_username, sender_display_name, sender_is_bot, message_kind,
            content_text, reply_to_message_id, sent_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
         FROM telegram_groups
         WHERE id = $1 AND message_mode = 'all'
         ON CONFLICT (group_id, telegram_message_id) DO NOTHING
         RETURNING id`,
        [
          groupId,
          messageId,
          threadId,
          sender.id,
          sender.username ?? null,
          displayName(message),
          sender.isBot,
          messageKind(message),
          contentText(message),
          replyToMessageId,
          sentAt(message),
        ],
      );
      if (!inserted.rowCount) {
        const currentMode = await client.query<{ message_mode: "addressed_only" | "all" }>(
          "SELECT message_mode FROM telegram_groups WHERE id = $1",
          [groupId],
        );
        await client.query("COMMIT");
        return currentMode.rows[0]?.message_mode === "all" ? "duplicate" : "mode_disabled";
      }

      // Retention is physical and group-wide; topic isolation applies only to model reads.
      await client.query(
        `DELETE FROM telegram_group_messages
         WHERE id IN (
           SELECT id
           FROM telegram_group_messages
           WHERE group_id = $1
           ORDER BY telegram_message_id DESC
           OFFSET $2
         )`,
        [groupId, TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES],
      );
      await client.query("COMMIT");
      return "inserted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async listBefore(input) {
    requirePositiveBigint(input.beforeTelegramMessageId, "message_id");
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES
    ) {
      throw new Error(
        `AGENT_TELEGRAM_JOURNAL_LIMIT_INVALID: Лимит сообщений журнала должен быть целым числом от 1 до ${TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES}`,
      );
    }
    if (input.messageThreadId !== null) {
      requirePositiveBigint(input.messageThreadId, "message_thread_id");
    }

    // The inner query takes the newest numeric IDs; the outer query restores chronology.
    const result = await database().query<JournalRow>(
      `SELECT * FROM (
         SELECT telegram_message_id::text, message_thread_id::text,
                telegram_user_id, sender_username, sender_display_name, sender_is_bot,
                message_kind, content_text, reply_to_message_id::text, sent_at
         FROM telegram_group_messages
         WHERE group_id = $1
           AND telegram_message_id < $2
           AND message_thread_id IS NOT DISTINCT FROM $3::bigint
         ORDER BY telegram_message_id DESC
         LIMIT $4
       ) AS recent
       ORDER BY telegram_message_id::bigint ASC`,
      [
        input.groupId,
        input.beforeTelegramMessageId,
        input.messageThreadId,
        input.limit,
      ],
    );
    return result.rows.map((row) => ({
      contentText: row.content_text,
      messageKind: row.message_kind,
      messageThreadId: row.message_thread_id,
      replyToMessageId: row.reply_to_message_id,
      senderDisplayName: row.sender_display_name,
      senderIsBot: row.sender_is_bot,
      senderUsername: row.sender_username,
      sentAt: row.sent_at.toISOString(),
      telegramMessageId: row.telegram_message_id,
      telegramUserId: row.telegram_user_id,
    }));
  },
};
