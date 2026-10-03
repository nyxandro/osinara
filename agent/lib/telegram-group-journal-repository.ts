/**
 * PostgreSQL unified Telegram group timeline repository.
 *
 * Exports:
 * - `TelegramGroupJournalRepository`: inbound, agent-delivery, context, and search contract.
 * - `TelegramGroupHistorySearchInput`: bounded model-history query after trusted authorization.
 * - `telegramGroupJournalRepository`: monotonic timeline with chunk aliases and retention.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

import { TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES } from "../config.js";
import { database } from "./database.js";
import {
  nextTelegramGroupSequence,
  recordTelegramAgentResponse,
  type RecordTelegramAgentResponseInput,
} from "./telegram-agent-timeline-repository.js";
import type {
  TelegramGroupAttachmentSummary,
  TelegramGroupJournalEntry,
} from "./telegram-group-journal-context.js";
import {
  lockTelegramGroupJournal,
  pruneTelegramGroupJournal,
  requireTelegramPositiveBigint,
  telegramForumTopicId,
  telegramMessageContent,
  telegramMessageKind,
  telegramMessageSentAt,
} from "./telegram-group-message-storage.js";
import type {
  TelegramInboundActor,
  TelegramTimelineActorKind,
} from "./telegram-inbound-actor.js";

const HISTORY_MAX_LIMIT = 100;

interface ListRecentInput {
  anchorEntryId: string | null;
  beforeSequence: string | null;
  groupId: string;
  limit: number;
  messageThreadId: string | null;
}

export interface TelegramGroupHistorySearchInput extends ListRecentInput {
  allTopics?: boolean;
  from?: Date | null;
  participant?: string | null;
  query?: string | null;
  sequenceFrom?: string | null;
  sequenceTo?: string | null;
  to?: Date | null;
}

export interface TimelineRecordResult {
  entryId: string;
  replyToAgent: boolean;
  replyTargetUnavailable: boolean;
  replyToSequenceId: string | null;
  sequenceId: string;
  status: "duplicate" | "inserted";
}

export interface TelegramGroupJournalRepository {
  listIncremental(input: {
    afterSequence: string;
    anchorEntryId: string;
    applicationSessionId: string;
    beforeSequence: string;
    groupId: string;
    limit: number;
    messageThreadId: string | null;
  }): Promise<{ entries: TelegramGroupJournalEntry[]; omittedBeforeSequence: string | null }>;
  listRecent(input: ListRecentInput): Promise<TelegramGroupJournalEntry[]>;
  record(
    groupId: string,
    message: TelegramMessage,
    actor: TelegramInboundActor,
  ): Promise<TimelineRecordResult>;
  recordAgentResponse(input: RecordTelegramAgentResponseInput): Promise<{ entryId: string; sequenceId: string }>;
  search(input: TelegramGroupHistorySearchInput): Promise<{
    entries: TelegramGroupJournalEntry[];
    nextBeforeSequence: string | null;
  }>;
}

interface TimelineRow {
  actor_id: string;
  actor_kind: TelegramTimelineActorKind;
  attachment_file_name: string | null;
  attachment_kind: "document" | "photo" | null;
  attachment_media_type: string | null;
  attachment_size: string | null;
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
  telegram_sender_chat_id: string | null;
  telegram_user_id: string | null;
  selected_boundary?: string;
  selected_count?: string;
  total_count?: string;
}

const TIMELINE_COLUMNS = `message.id, message.sequence_id::text, message.actor_kind,
  message.actor_id, message.telegram_message_id::text, message.message_thread_id::text,
  message.telegram_user_id, message.telegram_sender_chat_id,
  message.sender_username, message.sender_display_name,
  message.sender_is_bot, message.message_kind, message.content_text,
  message.reply_to_message_id::text, message.reply_to_sequence_id::text,
  message.sent_at, message.attachment_file_name, message.attachment_media_type,
  message.attachment_size::text, message.attachment_kind`;

function attachment(row: TimelineRow): TelegramGroupAttachmentSummary | undefined {
  if (row.attachment_kind === null) return undefined;
  return {
    attachmentId: row.id,
    ...(row.attachment_file_name === null ? {} : { fileName: row.attachment_file_name }),
    kind: row.attachment_kind,
    ...(row.attachment_media_type === null ? {} : { mediaType: row.attachment_media_type }),
    ...(row.attachment_size === null ? {} : { size: Number(row.attachment_size) }),
  };
}

function project(row: TimelineRow): TelegramGroupJournalEntry {
  const summary = attachment(row);
  return {
    ...(summary === undefined ? {} : { attachment: summary }),
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
    telegramSenderChatId: row.telegram_sender_chat_id,
    telegramUserId: row.telegram_user_id,
  };
}

function validateList(input: ListRecentInput, maxLimit: number): void {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > maxLimit) {
    throw new Error(
      `AGENT_TELEGRAM_TIMELINE_LIMIT_INVALID: Лимит истории должен быть целым числом от 1 до ${maxLimit}`,
    );
  }
  if (input.beforeSequence !== null) requireTelegramPositiveBigint(input.beforeSequence, "before_sequence");
  if (input.messageThreadId !== null) requireTelegramPositiveBigint(input.messageThreadId, "message_thread_id");
}

async function listRows(input: ListRecentInput): Promise<TelegramGroupJournalEntry[]> {
  validateList(input, TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES);
  // Recursive ancestors are bounded to two trusted reply edges and may cross the recent window.
  const result = await database().query<TimelineRow>(
    `WITH RECURSIVE recent AS (
       SELECT id FROM telegram_group_messages
       WHERE group_id = $1
         AND message_thread_id IS NOT DISTINCT FROM $2::bigint
         AND ($3::bigint IS NULL OR sequence_id < $3)
       ORDER BY sequence_id DESC LIMIT $4
     ), ancestry(id, depth) AS (
       SELECT id, 0 FROM recent
       UNION
       SELECT id, -1 FROM telegram_group_messages
       WHERE id = $5::uuid AND group_id = $1
       UNION
       SELECT parent.id, ancestry.depth + 1
       FROM ancestry
        JOIN telegram_group_messages child ON child.id = ancestry.id
        JOIN telegram_group_messages parent ON parent.id = child.reply_to_entry_id
        WHERE ancestry.depth < 2
          AND parent.group_id = $1
          AND parent.message_thread_id IS NOT DISTINCT FROM $2::bigint
     )
     SELECT ${TIMELINE_COLUMNS}
     FROM telegram_group_messages message
     WHERE message.id IN (SELECT id FROM ancestry)
       AND ($5::uuid IS NULL OR message.id <> $5)
     ORDER BY message.sequence_id`,
    [input.groupId, input.messageThreadId, input.beforeSequence, input.limit, input.anchorEntryId],
  );
  return result.rows.map(project);
}

export const telegramGroupJournalRepository: TelegramGroupJournalRepository = {
  async listIncremental(input) {
    validateList({
      anchorEntryId: null,
      beforeSequence: input.beforeSequence,
      groupId: input.groupId,
      limit: input.limit,
      messageThreadId: input.messageThreadId,
    }, TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES);
    requireTelegramPositiveBigint(input.afterSequence, "after_sequence");
    if (BigInt(input.afterSequence) >= BigInt(input.beforeSequence)) {
      throw new Error(
        "AGENT_TELEGRAM_TIMELINE_RANGE_INVALID: Начало диапазона истории должно предшествовать его окончанию",
      );
    }
    const result = await database().query<TimelineRow>(
      `WITH RECURSIVE eligible AS (
         SELECT message.id, message.sequence_id, count(*) OVER () AS total_count
           FROM telegram_group_messages message
          WHERE message.group_id = $1
            AND message.message_thread_id IS NOT DISTINCT FROM $2::bigint
            AND message.sequence_id > $3::bigint
            AND message.sequence_id < $4::bigint
            AND message.application_session_id IS DISTINCT FROM $5::uuid
          ORDER BY message.sequence_id DESC
          LIMIT $6
        ), ancestry(id, depth) AS (
          SELECT id, 0 FROM eligible
          UNION
          SELECT id, -1 FROM telegram_group_messages
           WHERE id = $7::uuid AND group_id = $1
          UNION
          SELECT parent.id, ancestry.depth + 1
           FROM ancestry
           JOIN telegram_group_messages child ON child.id = ancestry.id
           JOIN telegram_group_messages parent ON parent.id = child.reply_to_entry_id
          WHERE ancestry.depth < 2
            AND parent.group_id = $1
            AND parent.message_thread_id IS NOT DISTINCT FROM $2::bigint
       )
       SELECT ${TIMELINE_COLUMNS},
              (SELECT max(total_count)::text FROM eligible) AS total_count,
              (SELECT count(*)::text FROM eligible) AS selected_count,
              (SELECT min(sequence_id)::text FROM eligible) AS selected_boundary
         FROM telegram_group_messages message
         WHERE message.id IN (SELECT id FROM ancestry)
           AND message.id <> $7::uuid
         ORDER BY message.sequence_id`,
      [input.groupId, input.messageThreadId, input.afterSequence, input.beforeSequence,
        input.applicationSessionId, input.limit, input.anchorEntryId],
    );
    const totalCount = Number(result.rows[0]?.total_count ?? 0);
    const selectedCount = Number(result.rows[0]?.selected_count ?? 0);
    return {
      entries: result.rows.map(project),
      omittedBeforeSequence: totalCount > selectedCount
        ? result.rows[0]?.selected_boundary ?? input.beforeSequence
        : null,
    };
  },

  async record(groupId, message, actor) {
    const messageId = requireTelegramPositiveBigint(message.messageId, "message_id");
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockTelegramGroupJournal(client, groupId);
      const duplicate = await client.query<{
        entry_id: string;
        reply_to_entry_id: string | null;
        reply_to_message_id: string | null;
        reply_to_sequence_id: string | null;
        sequence_id: string;
      }>(
        `SELECT alias.entry_id, message.sequence_id::text,
                message.reply_to_entry_id::text, message.reply_to_message_id::text,
                message.reply_to_sequence_id::text
         FROM telegram_group_message_ids alias
         JOIN telegram_group_messages message ON message.id = alias.entry_id
         WHERE alias.group_id = $1 AND alias.telegram_message_id = $2`,
        [groupId, messageId],
      );
      if (duplicate.rows[0]) {
        await client.query("COMMIT");
        return {
          entryId: duplicate.rows[0].entry_id,
          replyToAgent: false,
          replyTargetUnavailable: duplicate.rows[0].reply_to_message_id !== null &&
            duplicate.rows[0].reply_to_entry_id === null,
          replyToSequenceId: duplicate.rows[0].reply_to_entry_id === null
            ? null
            : duplicate.rows[0].reply_to_sequence_id,
          sequenceId: duplicate.rows[0].sequence_id,
          status: "duplicate",
        };
      }
      const sequenceId = await nextTelegramGroupSequence(client, groupId);
      const replyId = message.replyToMessage
        ? requireTelegramPositiveBigint(message.replyToMessage.messageId, "reply_to_message_id")
        : null;
      const replyTarget = replyId === null
        ? null
        : (await client.query<{
          actor_kind: TelegramTimelineActorKind;
          entry_id: string;
          sequence_id: string;
        }>(
          `SELECT alias.entry_id, target.actor_kind, target.sequence_id::text
           FROM telegram_group_message_ids alias
           JOIN telegram_group_messages target ON target.id = alias.entry_id
           WHERE alias.group_id = $1 AND alias.telegram_message_id = $2`,
          [groupId, replyId],
        )).rows[0] ?? null;
      const inserted = await client.query<{ id: string }>(
         `INSERT INTO telegram_group_messages
           (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
             message_thread_id, telegram_user_id, telegram_sender_chat_id, sender_username,
             sender_display_name, sender_is_bot, message_kind, content_text,
             reply_to_message_id, reply_to_entry_id, reply_to_sequence_id, sent_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          RETURNING id`,
        [groupId, sequenceId, actor.timelineKind, actor.actorId, messageId,
          telegramForumTopicId(message),
          actor.kind === "telegram_channel" ? null : actor.id,
          actor.kind === "telegram_channel" ? actor.id : null, actor.username, actor.displayName,
          actor.kind === "telegram_bot",
          telegramMessageKind(message), telegramMessageContent(message), replyId,
          replyTarget?.entry_id ?? null, replyTarget?.sequence_id ?? null,
          telegramMessageSentAt(message)],
      );
      const entryId = inserted.rows[0]!.id;
      await client.query(
        "INSERT INTO telegram_group_message_ids (group_id, telegram_message_id, entry_id) VALUES ($1, $2, $3)",
        [groupId, messageId, entryId],
      );
      await pruneTelegramGroupJournal(client, groupId);
      // Pruning can remove an old target in this transaction; only retained targets are model-visible.
      const retainedReplyTarget = replyTarget === null
        ? null
        : (await client.query<{ id: string }>(
            "SELECT id FROM telegram_group_messages WHERE id = $1 AND group_id = $2",
            [replyTarget.entry_id, groupId],
          )).rows[0] ?? null;
      await client.query("COMMIT");
      return {
        entryId,
        replyToAgent: replyTarget?.actor_kind === "agent_self",
        replyTargetUnavailable: replyId !== null && retainedReplyTarget === null,
        replyToSequenceId: retainedReplyTarget === null ? null : replyTarget?.sequence_id ?? null,
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

  recordAgentResponse: recordTelegramAgentResponse,

  listRecent: listRows,

  async search(input) {
    validateList(input, HISTORY_MAX_LIMIT);
    for (const value of [input.sequenceFrom, input.sequenceTo]) {
      if (value) requireTelegramPositiveBigint(value, "sequence_range");
    }
    const result = await database().query<TimelineRow>(
      `SELECT ${TIMELINE_COLUMNS}
       FROM telegram_group_messages message
       WHERE message.group_id = $1
          AND ($11::boolean OR message.message_thread_id IS NOT DISTINCT FROM $2::bigint)
         AND ($3::bigint IS NULL OR message.sequence_id < $3)
         AND ($4::bigint IS NULL OR message.sequence_id >= $4)
         AND ($5::bigint IS NULL OR message.sequence_id <= $5)
         AND ($6::timestamptz IS NULL OR message.sent_at >= $6)
         AND ($7::timestamptz IS NULL OR message.sent_at <= $7)
         AND ($8::text IS NULL OR message.actor_id = $8 OR message.sender_username = $8)
         AND ($9::text IS NULL OR position(lower($9) in lower(coalesce(message.content_text, ''))) > 0)
       ORDER BY message.sequence_id DESC LIMIT $10`,
      [input.groupId, input.messageThreadId, input.beforeSequence, input.sequenceFrom,
        input.sequenceTo, input.from, input.to, input.participant, input.query, input.limit + 1,
        input.allTopics === true],
    );
    const hasMore = result.rows.length > input.limit;
    const page = result.rows.slice(0, input.limit).reverse().map(project);
    return { entries: page, nextBeforeSequence: hasMore ? page[0]!.sequenceId : null };
  },
};
