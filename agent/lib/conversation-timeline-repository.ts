/**
 * Unified personal/family/group Telegram conversation timeline writes and reads.
 *
 * Exports:
 * - `ConversationTimelineRecordResult`: idempotent inbound logical-entry identity.
 * - `RecordConversationAgentResponseInput`: successfully delivered agent response projection.
 * - `conversationTimelineRepository`: conversation-scoped inbound, delivery, context, and retention.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import type { PoolClient } from "pg";

import { TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES } from "../config.js";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type { TelegramGroupJournalEntry } from "./telegram-group-journal-context.js";
import {
  requireTelegramPositiveBigint,
  telegramMessageContent,
  telegramMessageKind,
  telegramMessageSentAt,
  telegramSenderDisplayName,
} from "./telegram-group-message-storage.js";

const AGENT_ACTOR_ID = "agent:osinara";
const AGENT_DISPLAY_NAME = "Осинара";

interface ConversationBoundary {
  family_id: string;
  id: string;
  owner_telegram_user_id: string | null;
  telegram_chat_id: string;
  telegram_group_id: string | null;
}

interface TimelineRow {
  actor_id: string;
  actor_kind: "agent_self" | "user";
  content_text: string | null;
  id: string;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_message_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sender_is_bot: boolean;
  sender_username: string | null;
  sent_at: Date;
  sequence_id: string;
  telegram_message_id: string;
  telegram_user_id: string | null;
  total_count?: string;
}

export interface ConversationTimelineRecordResult {
  entryId: string;
  replyTargetUnavailable: boolean;
  replyToSequenceId: string | null;
  sequenceId: string;
  status: "duplicate" | "inserted";
}

export interface RecordConversationAgentResponseInput {
  applicationSessionId: string | null;
  contentText: string;
  conversationId: string;
  deliveredAt: Date;
  messageThreadId: string | null;
  replyToEntryId: string | null;
  telegramMessageIds: readonly string[];
}

const TIMELINE_COLUMNS = `message.id, message.sequence_id::text, message.actor_kind,
  message.actor_id, message.telegram_message_id::text, message.message_thread_id::text,
  message.telegram_user_id, message.sender_username, message.sender_display_name,
  message.sender_is_bot, message.message_kind, message.content_text,
  message.reply_to_message_id::text, message.reply_to_sequence_id::text, message.sent_at`;

function project(row: TimelineRow): TelegramGroupJournalEntry {
  return {
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    contentText: row.content_text,
    entryId: row.id,
    messageKind: row.message_kind,
    messageThreadId: row.message_thread_id,
    replyToMessageId: row.reply_to_message_id,
    replyToSequenceId: row.reply_to_sequence_id,
    senderDisplayName: row.sender_display_name,
    senderIsBot: row.sender_is_bot,
    senderUsername: row.sender_username,
    sentAt: row.sent_at.toISOString(),
    sequenceId: row.sequence_id,
    telegramMessageId: row.telegram_message_id,
    telegramUserId: row.telegram_user_id,
  };
}

async function boundary(client: PoolClient, conversationId: string): Promise<ConversationBoundary> {
  const result = await client.query<ConversationBoundary>(
    `SELECT conversation.id, conversation.family_id, conversation.telegram_chat_id,
            conversation.telegram_group_id, app_user.telegram_user_id AS owner_telegram_user_id
     FROM application_conversations AS conversation
     LEFT JOIN users AS app_user ON app_user.id = conversation.owner_user_id
     WHERE conversation.id = $1 FOR SHARE OF conversation`,
    [conversationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(
      "AGENT_APPLICATION_CONVERSATION_NOT_FOUND",
      "Стабильный разговор больше не существует",
    );
  }
  return row;
}

async function lock(client: PoolClient, conversationId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationId]);
}

async function nextSequence(client: PoolClient, conversationId: string): Promise<string> {
  const result = await client.query<{ sequence_id: string }>(
    `UPDATE application_conversations
     SET next_timeline_sequence = greatest(next_timeline_sequence, coalesce((
       SELECT max(sequence_id) FROM telegram_group_messages WHERE conversation_id = $1
     ), 0)) + 1, updated_at = now()
     WHERE id = $1 RETURNING next_timeline_sequence::text AS sequence_id`,
    [conversationId],
  );
  const value = result.rows[0]?.sequence_id;
  if (!value) {
    throw new AppError("AGENT_APPLICATION_CONVERSATION_NOT_FOUND", "Разговор больше не существует");
  }
  return value;
}

async function prune(client: PoolClient, conversationId: string): Promise<void> {
  await client.query(
     `DELETE FROM telegram_group_messages WHERE id IN (
       SELECT id FROM telegram_group_messages WHERE conversation_id = $1
       ORDER BY sequence_id DESC OFFSET $2
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
    [conversationId, TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES],
  );
}

async function list(input: {
  afterSequence: string | null;
  applicationSessionId: string | null;
  beforeSequence: string;
  conversationId: string;
  limit: number;
}): Promise<{ entries: TelegramGroupJournalEntry[]; omittedBeforeSequence: string | null }> {
  const result = await database().query<TimelineRow>(
    `WITH eligible AS (
       SELECT ${TIMELINE_COLUMNS}, count(*) OVER ()::text AS total_count
       FROM telegram_group_messages AS message
       WHERE message.conversation_id = $1
         AND ($2::bigint IS NULL OR message.sequence_id > $2)
         AND message.sequence_id < $3::bigint
         AND ($4::uuid IS NULL OR message.application_session_id IS DISTINCT FROM $4)
       ORDER BY message.sequence_id DESC LIMIT $5
     ) SELECT * FROM eligible ORDER BY sequence_id::bigint`,
    [input.conversationId, input.afterSequence, input.beforeSequence,
      input.applicationSessionId, input.limit],
  );
  const total = Number(result.rows[0]?.total_count ?? 0);
  const entries = result.rows.map(project);
  return {
    entries,
    omittedBeforeSequence: total > entries.length ? entries[0]?.sequenceId ?? null : null,
  };
}

export const conversationTimelineRepository = {
  async listIncremental(input: {
    afterSequence: string;
    applicationSessionId: string;
    beforeSequence: string;
    conversationId: string;
    limit: number;
  }) {
    return await list(input);
  },

  async listRecent(input: {
    beforeSequence: string;
    conversationId: string;
    limit: number;
  }): Promise<TelegramGroupJournalEntry[]> {
    return (await list({ ...input, afterSequence: null, applicationSessionId: null })).entries;
  },

  async recordInbound(
    conversationId: string,
    message: TelegramMessage,
  ): Promise<ConversationTimelineRecordResult> {
    const sender = message.from;
    if (!sender) {
      throw new AppError("AGENT_TELEGRAM_MESSAGE_INVALID", "Telegram не передал отправителя сообщения");
    }
    const messageId = requireTelegramPositiveBigint(message.messageId, "message_id");
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lock(client, conversationId);
      const conversation = await boundary(client, conversationId);
      if (
        conversation.telegram_chat_id !== message.chat.id ||
        (conversation.owner_telegram_user_id !== null && conversation.owner_telegram_user_id !== sender.id)
      ) {
        throw new AppError(
          "AGENT_CONVERSATION_TIMELINE_BOUNDARY_INVALID",
          "Сообщение не принадлежит проверенному разговору",
        );
      }
      const duplicate = await client.query<{ entry_id: string; sequence_id: string }>(
        `SELECT alias.entry_id, entry.sequence_id::text FROM telegram_group_message_ids AS alias
         JOIN telegram_group_messages AS entry ON entry.id = alias.entry_id
         WHERE alias.conversation_id = $1 AND alias.telegram_message_id = $2`,
        [conversationId, messageId],
      );
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return {
          entryId: duplicate.rows[0].entry_id,
          replyTargetUnavailable: false,
          replyToSequenceId: null,
          sequenceId: duplicate.rows[0].sequence_id,
          status: "duplicate",
        };
      }
      const replyMessageId = message.replyToMessage
        ? requireTelegramPositiveBigint(message.replyToMessage.messageId, "reply_to_message_id")
        : null;
      const reply = replyMessageId === null ? null : (await client.query<{
        entry_id: string;
        sequence_id: string;
      }>(
        `SELECT alias.entry_id, entry.sequence_id::text FROM telegram_group_message_ids AS alias
         JOIN telegram_group_messages AS entry ON entry.id = alias.entry_id
         WHERE alias.conversation_id = $1 AND alias.telegram_message_id = $2`,
        [conversationId, replyMessageId],
      )).rows[0] ?? null;
      const sequenceId = await nextSequence(client, conversationId);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
            telegram_user_id, sender_username, sender_display_name, sender_is_bot, message_kind,
            content_text, reply_to_message_id, reply_to_entry_id, reply_to_sequence_id, sent_at)
         VALUES ($1, $2, $3, 'user', $4, $5, $6, $7, $8, false, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [conversationId, conversation.telegram_group_id, sequenceId, `telegram:${sender.id}`,
          messageId, sender.id, sender.username ?? null, telegramSenderDisplayName(message),
          telegramMessageKind(message), telegramMessageContent(message), replyMessageId,
          reply?.entry_id ?? null, reply?.sequence_id ?? null, telegramMessageSentAt(message)],
      );
      const entryId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO telegram_group_message_ids
           (conversation_id, group_id, telegram_message_id, entry_id) VALUES ($1, $2, $3, $4)`,
        [conversationId, conversation.telegram_group_id, messageId, entryId],
      );
      await prune(client, conversationId);
      await client.query("COMMIT");
      return {
        entryId,
        replyTargetUnavailable: replyMessageId !== null && reply === null,
        replyToSequenceId: reply?.sequence_id ?? null,
        sequenceId,
        status: "inserted",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async recordAgentResponse(
    input: RecordConversationAgentResponseInput,
  ): Promise<{ entryId: string; sequenceId: string }> {
    if (!input.contentText.trim() || input.telegramMessageIds.length === 0) {
      throw new AppError(
        "AGENT_TELEGRAM_TIMELINE_DELIVERY_INVALID",
        "Нет подтверждённого финального ответа для истории",
      );
    }
    const ids = input.telegramMessageIds.map((id) => requireTelegramPositiveBigint(id, "message_id"));
    if (new Set(ids).size !== ids.length) {
      throw new AppError(
        "AGENT_TELEGRAM_TIMELINE_DELIVERY_INVALID",
        "Telegram message IDs ответа должны быть уникальны",
      );
    }
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lock(client, input.conversationId);
      const conversation = await boundary(client, input.conversationId);
      const existing = await client.query<{ entry_id: string; sequence_id: string }>(
        `SELECT alias.entry_id, entry.sequence_id::text FROM telegram_group_message_ids AS alias
         JOIN telegram_group_messages AS entry ON entry.id = alias.entry_id
         WHERE alias.conversation_id = $1 AND alias.telegram_message_id = ANY($2::bigint[])`,
        [input.conversationId, ids],
      );
      if (existing.rows.length > 0) {
        const first = existing.rows[0]!;
        if (existing.rows.length !== ids.length || existing.rows.some((row) => row.entry_id !== first.entry_id)) {
          throw new AppError(
            "AGENT_TELEGRAM_TIMELINE_ALIAS_CONFLICT",
            "Telegram-сообщение уже связано с другой записью истории",
          );
        }
        await client.query("COMMIT");
        return { entryId: first.entry_id, sequenceId: first.sequence_id };
      }
      const sequenceId = await nextSequence(client, input.conversationId);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
            message_thread_id, sender_display_name, sender_is_bot, message_kind, content_text,
            reply_to_entry_id, reply_to_sequence_id, sent_at, application_session_id)
         VALUES ($1, $2, $3, 'agent_self', $4, $5, $6, $7, true, 'text', $8,
                 (SELECT id FROM telegram_group_messages WHERE id = $9 AND conversation_id = $1),
                 (SELECT sequence_id FROM telegram_group_messages WHERE id = $9 AND conversation_id = $1),
                 $10, $11) RETURNING id`,
        [input.conversationId, conversation.telegram_group_id, sequenceId, AGENT_ACTOR_ID, ids[0],
          input.messageThreadId, AGENT_DISPLAY_NAME, input.contentText, input.replyToEntryId,
          input.deliveredAt, input.applicationSessionId],
      );
      const entryId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO telegram_group_message_ids
           (conversation_id, group_id, telegram_message_id, entry_id)
         SELECT $1, $2, unnest($3::bigint[]), $4`,
        [input.conversationId, conversation.telegram_group_id, ids, entryId],
      );
      await prune(client, input.conversationId);
      await client.query("COMMIT");
      return { entryId, sequenceId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
