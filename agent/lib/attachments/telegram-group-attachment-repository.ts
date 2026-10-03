/**
 * Lazy registered-group Telegram attachment reference repository.
 *
 * Exports:
 * - `TelegramGroupAttachmentRepository`: authorized record, list, and materialization lookup contract.
 * - `telegramGroupAttachmentRepository`: PostgreSQL implementation over the bounded group journal.
 */
import type { TelegramMessage } from "../../runtime/telegram/inbound.js";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { TelegramGroupAttachmentSummary } from "../telegram-group-journal-context.js";
import {
  lockTelegramGroupJournal,
  requireTelegramPositiveBigint,
} from "../telegram-group-message-storage.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import {
  listTelegramGroupAttachments,
  type TelegramGroupAttachmentListItem,
  type TelegramGroupAttachmentListOptions,
} from "./telegram-group-attachment-list-repository.js";

interface AttachmentRow {
  attachment_file_id: string;
  attachment_file_name: string | null;
  attachment_file_unique_id: string | null;
  attachment_kind: "document" | "photo";
  attachment_media_type: string | null;
  attachment_size: string | null;
  id: string;
  telegram_chat_id: string;
  telegram_message_id: string;
}

interface AttachmentLookupRow {
  attachment: AttachmentRow | null;
  authorized: boolean;
  registered: boolean;
}

export interface TelegramGroupAttachmentRepository {
  captureReplyTarget(
    groupId: string,
    currentEntryId: string,
    target: TelegramMessage,
  ): Promise<(TelegramGroupAttachmentSummary & { telegramMessageId: string }) | null>;
  find(
    auth: WorkspaceAuthorization,
    attachmentId: string,
  ): Promise<{
    attachment: TelegramMessage["attachments"][number];
    chatId: string;
    messageId: string;
  }>;
  list(
    auth: WorkspaceAuthorization,
    options: TelegramGroupAttachmentListOptions,
  ): Promise<{ items: TelegramGroupAttachmentListItem[]; nextCursor: string | null }>;
  record(
    groupId: string,
    message: TelegramMessage,
  ): Promise<TelegramGroupAttachmentSummary & { telegramMessageId: string }>;
}

function attachmentSummary(row: Pick<
  AttachmentRow,
  "attachment_file_name" | "attachment_kind" | "attachment_media_type" | "attachment_size" | "id"
>): TelegramGroupAttachmentSummary {
  return {
    attachmentId: row.id,
    ...(row.attachment_file_name === null ? {} : { fileName: row.attachment_file_name }),
    kind: row.attachment_kind,
    ...(row.attachment_media_type === null ? {} : { mediaType: row.attachment_media_type }),
    ...(row.attachment_size === null ? {} : { size: Number(row.attachment_size) }),
  };
}

function assertRegisteredGroupAttachmentAccess(auth: WorkspaceAuthorization): asserts auth is WorkspaceAuthorization & {
  groupId: string;
  groupType: "external" | "family_private";
  telegramChatType: "group" | "supergroup";
} {
  if (
    (auth.groupType !== "family_private" && auth.groupType !== "external") ||
    auth.groupId === null ||
    (auth.telegramChatType !== "group" && auth.telegramChatType !== "supergroup")
  ) {
    throw new AppError(
      "AGENT_TELEGRAM_ATTACHMENT_ACCESS_DENIED",
      "Вложения доступны только в исходной зарегистрированной группе",
    );
  }
}

export const telegramGroupAttachmentRepository: TelegramGroupAttachmentRepository = {
  async captureReplyTarget(groupId, currentEntryId, target) {
    if (target.attachments.length !== 1) {
      throw new AppError(
        "AGENT_TELEGRAM_ATTACHMENT_REFERENCE_INVALID",
        "Ответ Telegram должен содержать ровно одно поддерживаемое вложение",
      );
    }
    const attachment = target.attachments[0]!;
    const sourceMessageId = requireTelegramPositiveBigint(target.messageId, "attachment_source_message_id");
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockTelegramGroupJournal(client, groupId);
      // Enrich the observed target when its timeline entry exists. If Telegram supplied only a
      // nested reply snapshot, bind the opaque reference to the current entry without inventing
      // a second historical timeline message.
      const result = await client.query<AttachmentRow>(
        `WITH destination AS (
           SELECT COALESCE(
             (SELECT alias.entry_id
              FROM telegram_group_message_ids alias
              WHERE alias.group_id = $1 AND alias.telegram_message_id = $9),
             $2::uuid
           ) AS entry_id
         )
         UPDATE telegram_group_messages AS message
         SET attachment_file_id = $3,
             attachment_file_unique_id = $4,
             attachment_file_name = $5,
             attachment_media_type = $6,
             attachment_size = $7,
             attachment_kind = $8,
             attachment_source_message_id = $9
         FROM telegram_groups telegram_group, destination
         WHERE message.id = destination.entry_id AND message.group_id = $1
            AND telegram_group.id = message.group_id
            AND telegram_group.type IN ('family_private', 'external')
            AND (message.attachment_file_id IS NULL OR (
              message.attachment_file_id = $3 AND
              message.attachment_file_unique_id IS NOT DISTINCT FROM $4 AND
              message.attachment_file_name IS NOT DISTINCT FROM $5 AND
              message.attachment_media_type IS NOT DISTINCT FROM $6 AND
              message.attachment_size IS NOT DISTINCT FROM $7 AND
              message.attachment_kind = $8 AND
              message.attachment_source_message_id = $9
            ))
         RETURNING message.id, $9::text AS telegram_message_id,
                   message.attachment_file_id, message.attachment_file_unique_id,
                   message.attachment_file_name, message.attachment_media_type,
                   message.attachment_size::text, message.attachment_kind,
                   ''::text AS telegram_chat_id`,
        [groupId, currentEntryId, attachment.fileId, attachment.fileUniqueId ?? null,
          attachment.fileName ?? null, attachment.mediaType ?? null, attachment.size ?? null,
          attachment.kind, sourceMessageId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row ? { ...attachmentSummary(row), telegramMessageId: row.telegram_message_id } : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async find(auth, attachmentId) {
    assertRegisteredGroupAttachmentAccess(auth);
    // Resolve live authorization and the opaque reference in one database snapshot. A family
    // membership revoked after session creation therefore cannot release a Telegram file ID.
    const result = await database().query<AttachmentLookupRow>(
      `WITH registered_group AS (
         SELECT family_id
         FROM telegram_groups
         WHERE id = $2 AND family_id = $3 AND type = $4
       ), current_access AS (
         SELECT EXISTS (SELECT 1 FROM registered_group) AS registered,
                CASE WHEN $4 = 'external'
                  THEN EXISTS (SELECT 1 FROM registered_group)
                  ELSE EXISTS (
                    SELECT 1
                    FROM registered_group
                    JOIN family_memberships membership
                      ON membership.family_id = registered_group.family_id
                     AND membership.user_id = $5
                  )
                END AS authorized
       ), attachment AS (
         SELECT message.id, COALESCE(message.attachment_source_message_id,
                   message.telegram_message_id)::text AS telegram_message_id,
                message.attachment_file_id, message.attachment_file_unique_id,
                message.attachment_file_name, message.attachment_media_type,
                message.attachment_size::text, message.attachment_kind,
                telegram_group.telegram_chat_id
         FROM telegram_group_messages message
         JOIN telegram_groups telegram_group ON telegram_group.id = message.group_id
         WHERE message.id = $1 AND message.group_id = $2
           AND telegram_group.family_id = $3 AND telegram_group.type = $4
           AND message.attachment_file_id IS NOT NULL
       )
       SELECT current_access.authorized, current_access.registered,
              CASE WHEN attachment.id IS NULL THEN NULL ELSE to_jsonb(attachment) END AS attachment
       FROM current_access
       LEFT JOIN attachment ON current_access.authorized`,
      [attachmentId, auth.groupId, auth.familyId, auth.groupType, auth.userId],
    );
    const row = result.rows[0]!;
    if (!row.authorized && row.registered && auth.groupType === "family_private") {
      throw new AppError(
        "AGENT_TELEGRAM_ATTACHMENT_ACCESS_REVOKED",
        "Доступ к семейному вложению был отозван",
      );
    }
    const attachment = row.attachment;
    if (!attachment) {
      throw new AppError(
        "AGENT_TELEGRAM_ATTACHMENT_NOT_FOUND",
        "Вложение не найдено в текущей зарегистрированной группе",
      );
    }
    return {
      attachment: {
        fileId: attachment.attachment_file_id,
        ...(attachment.attachment_file_name === null
          ? {}
          : { fileName: attachment.attachment_file_name }),
        ...(attachment.attachment_file_unique_id === null
          ? {}
          : { fileUniqueId: attachment.attachment_file_unique_id }),
        kind: attachment.attachment_kind,
        ...(attachment.attachment_media_type === null
          ? {}
          : { mediaType: attachment.attachment_media_type }),
        ...(attachment.attachment_size === null
          ? {}
          : { size: Number(attachment.attachment_size) }),
      },
      chatId: attachment.telegram_chat_id,
      messageId: attachment.telegram_message_id,
    };
  },

  list: listTelegramGroupAttachments,

  async record(groupId, message) {
    if (message.attachments.length !== 1) {
      throw new AppError(
        "AGENT_TELEGRAM_ATTACHMENT_REFERENCE_INVALID",
        "Сообщение Telegram должно содержать ровно одно поддерживаемое вложение",
      );
    }
    const attachment = message.attachments[0]!;
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await lockTelegramGroupJournal(client, groupId);
      // The unified timeline owns entry creation and sequence allocation. This repository enriches
      // that exact human entry, so attachments cannot create a second persistence path.
      const result = await client.query<AttachmentRow>(
        `UPDATE telegram_group_messages AS message
         SET attachment_file_id = $3,
             attachment_file_unique_id = $4,
             attachment_file_name = $5,
             attachment_media_type = $6,
              attachment_size = $7,
              attachment_kind = $8,
              attachment_source_message_id = $2
         FROM telegram_groups telegram_group
         WHERE message.group_id = $1
           AND message.telegram_message_id = $2
           AND telegram_group.id = message.group_id
            AND telegram_group.type IN ('family_private', 'external')
           AND (message.attachment_file_id IS NULL OR (
             message.attachment_file_id = $3 AND
             message.attachment_file_unique_id IS NOT DISTINCT FROM $4 AND
             message.attachment_file_name IS NOT DISTINCT FROM $5 AND
             message.attachment_media_type IS NOT DISTINCT FROM $6 AND
             message.attachment_size IS NOT DISTINCT FROM $7 AND
             message.attachment_kind = $8
           ))
         RETURNING message.id, message.telegram_message_id::text, message.attachment_file_id,
                    attachment_file_unique_id, attachment_file_name, attachment_media_type,
                    attachment_size::text, attachment_kind, ''::text AS telegram_chat_id`,
        [
          groupId,
          requireTelegramPositiveBigint(message.messageId, "message_id"),
          attachment.fileId,
          attachment.fileUniqueId ?? null,
          attachment.fileName ?? null,
          attachment.mediaType ?? null,
          attachment.size ?? null,
          attachment.kind,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_TELEGRAM_ATTACHMENT_REFERENCE_CONFLICT",
          "Не удалось сохранить ссылку на вложение зарегистрированной группы",
        );
      }
      await client.query("COMMIT");
      return { ...attachmentSummary(row), telegramMessageId: row.telegram_message_id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
