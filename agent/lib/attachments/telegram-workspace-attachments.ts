/**
 * Authorized Telegram attachment ingestion.
 *
 * Exports:
 * - `StoredTelegramAttachment`: trusted persistent path advertised to the model.
 * - `UnavailableAnimationStill`, `TelegramAttachmentImport`: a GIF that came without a picture, and
 *   the result for one attachment.
 * - `createTelegramWorkspaceAttachmentImporter`: download, validate, and persist pipeline.
 *
 * Key construct:
 * - A GIF is stored as its middle frame (`animation-still.ts`). When no frame can be had, the GIF is
 *   not worth the person's message: the message goes on without it and the model learns it has no
 *   picture, as a video note goes on without its transcript.
 */
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";

import { TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE } from "../../config.js";
import { AppError, isAppError } from "../app-error.js";
import type {
  WorkspaceAuthorization,
  WorkspaceFileRecord,
  WorkspaceScope,
} from "../workspaces/workspace-repository.js";
import { validateAttachmentContent } from "./attachment-policy.js";
import { telegramInboxDirectory } from "./telegram-inbox-path.js";

interface AttachmentImporterDependencies {
  download(attachment: TelegramAttachment): Promise<Uint8Array>;
  extractAnimationStill(bytes: Uint8Array): Promise<Uint8Array>;
  writeBinary(auth: WorkspaceAuthorization, input: {
    bytes: Uint8Array;
    mediaType: string;
    operationKey: string;
    path: string;
    scope: WorkspaceScope;
  }): Promise<WorkspaceFileRecord>;
}

export interface StoredTelegramAttachment {
  mediaType: string;
  path: string;
  scope: WorkspaceScope;
  telegramMessageId: string;
}

export interface UnavailableAnimationStill {
  stillUnavailable: true;
  telegramMessageId: string;
}

export type TelegramAttachmentImport = StoredTelegramAttachment | UnavailableAnimationStill;

const MEDIA_TYPE_DEFAULT_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": ".json",
  "application/msword": ".doc",
  "application/pdf": ".pdf",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

function defaultAttachmentName(attachment: TelegramAttachment, index: number): string {
  if (attachment.fileName) return attachment.fileName;
  const identity = attachment.fileUniqueId ?? String(index + 1);
  const extension = attachment.kind === "photo"
    ? ".jpg"
    : attachment.mediaType
    ? MEDIA_TYPE_DEFAULT_EXTENSIONS[attachment.mediaType]
    : undefined;
  // Telegram file names are optional presentation metadata. Keep an opaque document storable even
  // when neither Telegram nor content detection can provide a meaningful extension.
  return `${attachment.kind}-${identity}${extension ?? ""}`;
}

function assertTelegramMessageId(value: string): void {
  if (!/^\d+$/u.test(value)) {
    throw new Error("AGENT_TELEGRAM_MESSAGE_ID_INVALID: Telegram message ID must be numeric");
  }
}

// What a GIF's own file can fail on: Telegram does not hand it over, or no frame comes out of it.
// A missing media tool or another fault of the server is not among them and fails the message.
const ANIMATION_STILL_UNAVAILABLE_CAUSES = new Set([
  "AGENT_ANIMATION_FORMAT_UNSUPPORTED",
  "AGENT_ANIMATION_STILL_FAILED",
  "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
  "AGENT_ATTACHMENT_DOWNLOAD_RESPONSE_INVALID",
  "AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE",
]);

/** The still of a GIF, or null when its file cannot be downloaded or cut; see the module note. */
async function animationStill(
  dependencies: AttachmentImporterDependencies,
  attachment: TelegramAttachment,
  telegramMessageId: string,
): Promise<Uint8Array | null> {
  try {
    return await dependencies.extractAnimationStill(await dependencies.download(attachment));
  } catch (error) {
    if (!isAppError(error) || !ANIMATION_STILL_UNAVAILABLE_CAUSES.has(error.code)) throw error;
    console.error(JSON.stringify({
      code: "AGENT_ANIMATION_STILL_UNAVAILABLE",
      cause: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(isAppError(error.cause) && error.cause.details !== undefined ? { causeDetails: error.cause.details } : {}),
      telegramMessageId,
    }));
    return null;
  }
}

// Populated only by the verified album composer; a native single-file message uses its own ID.
export interface TelegramWorkspaceAttachment extends TelegramAttachment {
  readonly telegramMessageId?: string;
}

export function createTelegramWorkspaceAttachmentImporter(
  dependencies: AttachmentImporterDependencies,
) {
  return {
    async persist(input: {
      attachments: readonly TelegramWorkspaceAttachment[];
      auth: WorkspaceAuthorization;
      chatId: string;
      messageId: string;
      scope: WorkspaceScope;
    }): Promise<TelegramAttachmentImport[]> {
      assertTelegramMessageId(input.messageId);
      if (input.attachments.length > TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new AppError(
          "AGENT_ATTACHMENT_COUNT_EXCEEDED",
          `В одном обращении можно обработать не более ${TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE} файлов. Отправьте оставшиеся файлы отдельно`,
        );
      }
      const sourceIds = input.attachments.map(attachment => {
        if (input.attachments.length > 1 && attachment.telegramMessageId === undefined) {
          throw new AppError("AGENT_ATTACHMENT_SOURCE_MISSING",
            "Не удалось определить исходные сообщения файлов. Отправьте пачку заново");
        }
        const sourceId = attachment.telegramMessageId ?? input.messageId;
        assertTelegramMessageId(sourceId);
        return sourceId;
      });
      if (new Set(sourceIds).size !== sourceIds.length) {
        throw new AppError("AGENT_ATTACHMENT_SOURCE_CONFLICT",
          "Несколько файлов привязаны к одному исходному сообщению. Отправьте пачку заново");
      }
      const imported: TelegramAttachmentImport[] = [];
      for (const [index, attachment] of input.attachments.entries()) {
        const sourceId = sourceIds[index]!;
        const inboxDirectory = telegramInboxDirectory(input.auth, input.scope, sourceId);
        const bytes = attachment.kind === "animation"
          ? await animationStill(dependencies, attachment, sourceId)
          : await dependencies.download(attachment);
        if (bytes === null) {
          imported.push({ stillUnavailable: true, telegramMessageId: sourceId });
          continue;
        }
        // Every scope keeps any file, typed by its bytes; an external group's copy stays in its own
        // isolated workspace (since 01.11.2026, text files only before).
        const validated = await validateAttachmentContent({
          bytes,
          ...(attachment.mediaType ? { declaredMediaType: attachment.mediaType } : {}),
          fileName: defaultAttachmentName(attachment, index),
          kind: attachment.kind === "animation" ? "photo" : attachment.kind,
        });

        // Content validation establishes the stored MIME and safe filename before persistence.
        // Each real Telegram message retains its own directory and idempotency identity. This also
        // preserves image lookup by message ID and repeated occurrences of the same file in an album.
        const path = `${inboxDirectory}/${validated.fileName}`;
        const file = await dependencies.writeBinary(input.auth, {
          bytes,
          mediaType: validated.mediaType,
          operationKey: `telegram-attachment:${input.chatId}:${sourceId}:${attachment.fileUniqueId ?? attachment.fileId}`,
          path,
          scope: input.scope,
        });
        imported.push({
          mediaType: file.mediaType,
          path: file.path,
          scope: file.scope,
          telegramMessageId: sourceId,
        });
      }
      return imported;
    },
  };
}
