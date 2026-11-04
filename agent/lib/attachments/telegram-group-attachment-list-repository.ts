/**
 * Live-authorized Telegram group attachment listing.
 *
 * Exports:
 * - `TelegramGroupAttachmentListItem`, `TelegramGroupAttachmentListOptions`: list contracts.
 * - `listTelegramGroupAttachments`: stable keyset page resolved with current family membership.
 */
import { TELEGRAM_ATTACHMENT_REFERENCE_LIST_MAX_LIMIT } from "../../config.js";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import {
  decodeBigintUuidCursor,
  encodeBigintUuidCursor,
  paginationFilterDigest,
} from "../keyset-pagination.js";
import type { TelegramGroupAttachmentSummary } from "../telegram-group-journal-context.js";
import { requireTelegramPositiveBigint } from "../telegram-group-message-storage.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";

interface AttachmentListAccessRow {
  attachment_file_id: string | null;
  attachment_file_name: string | null;
  attachment_file_unique_id: string | null;
  attachment_kind: "animation" | "document" | "photo" | null;
  attachment_media_type: string | null;
  attachment_size: string | null;
  authorized: boolean;
  content_text: string | null;
  id: string | null;
  registered: boolean;
  sender_display_name: string | null;
  sent_at: Date | null;
  sequence_id: string | null;
  telegram_chat_id: string | null;
  telegram_message_id: string | null;
}

interface AuthorizedAttachmentListRow extends AttachmentListAccessRow {
  attachment_file_id: string;
  attachment_kind: "animation" | "document" | "photo";
  id: string;
  sent_at: Date;
  sequence_id: string;
  telegram_chat_id: string;
  telegram_message_id: string;
}

export type TelegramGroupAttachmentListItem = TelegramGroupAttachmentSummary & {
  contentText: string | null;
  senderDisplayName: string | null;
  sentAt: string;
  telegramMessageId: string;
};

export interface TelegramGroupAttachmentListOptions {
  cursor?: string;
  fileName?: string;
  limit: number;
  messageThreadId: string | null;
}

function isAuthorizedRow(row: AttachmentListAccessRow): row is AuthorizedAttachmentListRow {
  return row.id !== null && row.attachment_file_id !== null && row.attachment_kind !== null &&
    row.sent_at !== null && row.sequence_id !== null && row.telegram_chat_id !== null &&
    row.telegram_message_id !== null;
}

function listItem(row: AuthorizedAttachmentListRow): TelegramGroupAttachmentListItem {
  return {
    attachmentId: row.id,
    ...(row.attachment_file_name === null ? {} : { fileName: row.attachment_file_name }),
    kind: row.attachment_kind,
    ...(row.attachment_media_type === null ? {} : { mediaType: row.attachment_media_type }),
    ...(row.attachment_size === null ? {} : { size: Number(row.attachment_size) }),
    contentText: row.content_text,
    senderDisplayName: row.sender_display_name,
    sentAt: row.sent_at.toISOString(),
    telegramMessageId: row.telegram_message_id,
  };
}

export async function listTelegramGroupAttachments(
  auth: WorkspaceAuthorization,
  options: TelegramGroupAttachmentListOptions,
): Promise<{ items: TelegramGroupAttachmentListItem[]; nextCursor: string | null }> {
  if (auth.groupType !== "family_private") {
    throw new AppError(
      "AGENT_TELEGRAM_ATTACHMENT_ACCESS_DENIED",
      "Список вложений доступен только в исходной семейной группе",
    );
  }
  if (options.messageThreadId !== null) {
    requireTelegramPositiveBigint(options.messageThreadId, "message_thread_id");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 ||
      options.limit > TELEGRAM_ATTACHMENT_REFERENCE_LIST_MAX_LIMIT) {
    throw new AppError(
      "AGENT_TELEGRAM_ATTACHMENT_LIMIT_INVALID",
      "Некорректный размер страницы вложений",
    );
  }

  const cursorBinding = paginationFilterDigest([
    "telegram-attachment-v1",
    auth.familyId,
    auth.groupId,
    auth.groupType,
    options.messageThreadId,
    options.fileName ?? null,
  ]);
  const cursor = decodeBigintUuidCursor(
    options.cursor,
    "AGENT_TELEGRAM_ATTACHMENT_CURSOR_INVALID",
    "Не удалось продолжить просмотр вложений",
    cursorBinding,
  );
  // Authorization and rows share one PostgreSQL statement, closing membership-revocation races.
  const result = await database().query<AttachmentListAccessRow>(
    `WITH registered_group AS (
       SELECT id, family_id, telegram_chat_id
       FROM telegram_groups
       WHERE id = $1 AND family_id = $2 AND type = $4
     ), current_access AS (
       SELECT EXISTS (SELECT 1 FROM registered_group) AS registered,
              EXISTS (
                SELECT 1
                FROM registered_group
                JOIN family_memberships membership
                  ON membership.family_id = registered_group.family_id
                 AND membership.user_id = $9
              ) AS authorized
     )
     SELECT current_access.authorized, current_access.registered,
            message.id, message.telegram_message_id,
            message.attachment_file_id, message.attachment_file_unique_id,
            message.attachment_file_name, message.attachment_media_type,
            message.attachment_size, message.attachment_kind,
            message.content_text, message.sender_display_name, message.sent_at,
            message.sequence_id, message.telegram_chat_id
     FROM current_access
     LEFT JOIN LATERAL (
       SELECT journal.id, COALESCE(journal.attachment_source_message_id,
                 journal.telegram_message_id)::text AS telegram_message_id,
              journal.attachment_file_id, journal.attachment_file_unique_id,
              journal.attachment_file_name, journal.attachment_media_type,
              journal.attachment_size::text, journal.attachment_kind,
              journal.content_text, journal.sender_display_name, journal.sent_at,
              journal.sequence_id::text, registered_group.telegram_chat_id
       FROM telegram_group_messages journal
       JOIN registered_group ON registered_group.id = journal.group_id
       WHERE journal.message_thread_id IS NOT DISTINCT FROM $3::bigint
         AND journal.attachment_file_id IS NOT NULL
         AND ($5::text IS NULL OR journal.attachment_file_name = $5)
         AND ($6::bigint IS NULL OR (journal.sequence_id, journal.id) < ($6, $7::uuid))
       ORDER BY journal.sequence_id DESC, journal.id DESC
       LIMIT $8
     ) AS message ON current_access.authorized`,
    [auth.groupId, auth.familyId, options.messageThreadId, auth.groupType,
      options.fileName ?? null, cursor?.sequence ?? null, cursor?.id ?? null,
      options.limit + 1, auth.userId],
  );
  const access = result.rows[0]!;
  if (!access.authorized) {
    throw new AppError(
      access.registered
        ? "AGENT_TELEGRAM_ATTACHMENT_ACCESS_REVOKED"
        : "AGENT_TELEGRAM_ATTACHMENT_ACCESS_DENIED",
      access.registered
        ? "Доступ к списку семейных вложений был отозван"
        : "Список вложений больше недоступен в этой группе",
    );
  }

  const authorizedRows = result.rows.filter(isAuthorizedRow);
  const rows = authorizedRows.slice(0, options.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(listItem),
    nextCursor: authorizedRows.length > options.limit && last
      ? encodeBigintUuidCursor(last.sequence_id, last.id, cursorBinding)
      : null,
  };
}
