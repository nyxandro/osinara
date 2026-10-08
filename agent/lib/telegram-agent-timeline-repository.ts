/**
 * Agent-authored Telegram group timeline writes.
 *
 * Exports:
 * - `RecordTelegramAgentResponseInput`: confirmed agent delivery projection.
 * - `nextTelegramGroupSequence`: transaction-scoped monotonic sequence allocation.
 * - `recordTelegramAgentResponse`: idempotent logical entry and chunk-alias persistence.
 */
import { AGENT_DISPLAY_NAME } from "./agent-name.js";
import type { PoolClient } from "pg";

import { database } from "./database.js";
import type { TelegramGroupAttachmentSummary } from "./telegram-group-journal-context.js";
import {
  lockTelegramGroupJournal,
  pruneTelegramGroupJournal,
  requireTelegramPositiveBigint,
} from "./telegram-group-message-storage.js";

const AGENT_ACTOR_ID = "agent:osinara";

export interface RecordTelegramAgentResponseInput {
  applicationSessionId: string | null;
  attachment?: Omit<TelegramGroupAttachmentSummary, "attachmentId">;
  contentText: string;
  deliveredAt: Date;
  groupId: string;
  messageThreadId: string | null;
  replyToEntryId: string | null;
  telegramMessageIds: readonly string[];
}

export async function nextTelegramGroupSequence(
  client: PoolClient,
  groupId: string,
): Promise<string> {
  const result = await client.query<{ sequence_id: string }>(
    `UPDATE application_conversations
     SET next_timeline_sequence = greatest(
       next_timeline_sequence,
       (SELECT next_timeline_sequence FROM telegram_groups WHERE id = $1),
       coalesce((SELECT max(sequence_id) FROM telegram_group_messages WHERE group_id = $1), 0)
     ) + 1
     WHERE telegram_group_id = $1 RETURNING next_timeline_sequence::text AS sequence_id`,
    [groupId],
  );
  const sequence = result.rows[0]?.sequence_id;
  if (!sequence) throw new Error("AGENT_TELEGRAM_GROUP_NOT_FOUND: Группа не зарегистрирована");
  await client.query(
    "UPDATE telegram_groups SET next_timeline_sequence = $2 WHERE id = $1",
    [groupId, sequence],
  );
  return sequence;
}

export async function recordTelegramAgentResponse(
  input: RecordTelegramAgentResponseInput,
): Promise<{ entryId: string; sequenceId: string }> {
  if (!input.contentText.trim() || input.telegramMessageIds.length === 0) {
    throw new Error(
      "AGENT_TELEGRAM_TIMELINE_DELIVERY_INVALID: Нет подтверждённого финального ответа для истории",
    );
  }
  const messageIds = input.telegramMessageIds.map((id) =>
    requireTelegramPositiveBigint(id, "message_id")
  );
  if (new Set(messageIds).size !== messageIds.length) {
    throw new Error(
      "AGENT_TELEGRAM_TIMELINE_DELIVERY_INVALID: Telegram message IDs ответа должны быть уникальны",
    );
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await lockTelegramGroupJournal(client, input.groupId);
    // Confirmed provider delivery can replay after a crash; aliases make projection idempotent.
    const existing = await client.query<{
      actor_kind: "agent_self" | "user";
      entry_id: string;
      sequence_id: string;
    }>(
      `SELECT alias.entry_id, message.actor_kind, message.sequence_id::text
         FROM telegram_group_message_ids alias
         JOIN telegram_group_messages message ON message.id = alias.entry_id
        WHERE alias.group_id = $1 AND alias.telegram_message_id = ANY($2::bigint[])`,
      [input.groupId, messageIds],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      const aliasesMatch = existing.rows.length === messageIds.length &&
        existing.rows.every((candidate) =>
          candidate.actor_kind === "agent_self" && candidate.entry_id === row.entry_id
        );
      if (!aliasesMatch) {
        throw new Error(
          "AGENT_TELEGRAM_TIMELINE_ALIAS_CONFLICT: Telegram-сообщение уже связано с другой записью истории",
        );
      }
      await client.query("COMMIT");
      return { entryId: row.entry_id, sequenceId: row.sequence_id };
    }

    const sequenceId = await nextTelegramGroupSequence(client, input.groupId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
          message_thread_id, sender_display_name, sender_is_bot, message_kind,
          content_text, reply_to_entry_id, reply_to_sequence_id, sent_at,
          application_session_id, attachment_file_name, attachment_media_type,
          attachment_size, attachment_kind)
       VALUES ($1, $2, 'agent_self', $3, $4, $5, $6, true, 'text', $7,
               (SELECT id FROM telegram_group_messages WHERE id = $8 AND group_id = $1),
               (SELECT sequence_id FROM telegram_group_messages WHERE id = $8 AND group_id = $1),
               $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [input.groupId, sequenceId, AGENT_ACTOR_ID, messageIds[0], input.messageThreadId,
        AGENT_DISPLAY_NAME, input.contentText, input.replyToEntryId, input.deliveredAt,
        input.applicationSessionId, input.attachment?.fileName ?? null,
        input.attachment?.mediaType ?? null, input.attachment?.size ?? null,
        input.attachment?.kind ?? null],
    );
    const entryId = inserted.rows[0]!.id;
    await client.query(
      `INSERT INTO telegram_group_message_ids (group_id, telegram_message_id, entry_id)
       SELECT $1, unnest($2::bigint[]), $3`,
      [input.groupId, messageIds, entryId],
    );
    await pruneTelegramGroupJournal(client, input.groupId);
    await client.query("COMMIT");
    return { entryId, sequenceId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
