/**
 * Lazy authorized Telegram attachment materialization.
 *
 * Exports:
 * - `createTelegramAttachmentMaterializer`: resolves one opaque reference and persists its bytes.
 * - `materializeTelegramAttachment`: production registered-group journal to workspace pipeline.
 */
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";

import { telegramGroupAttachmentRepository } from "./telegram-group-attachment-repository.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { AppError } from "../app-error.js";
import { downloadTelegramAttachment } from "./telegram-attachment-download.js";
import {
  createTelegramWorkspaceAttachmentImporter,
  type StoredTelegramAttachment,
} from "./telegram-workspace-attachments.js";

interface TelegramAttachmentMaterializerDependencies {
  findAttachment(
    auth: WorkspaceAuthorization,
    attachmentId: string,
  ): Promise<{
    attachment: TelegramAttachment;
    chatId: string;
    messageId: string;
  }>;
  persist(input: {
    attachments: readonly TelegramAttachment[];
    auth: WorkspaceAuthorization;
    chatId: string;
    messageId: string;
    scope: "family" | "group";
  }): Promise<StoredTelegramAttachment[]>;
}

export function createTelegramAttachmentMaterializer(
  dependencies: TelegramAttachmentMaterializerDependencies,
) {
  return async (
    auth: WorkspaceAuthorization,
    attachmentId: string,
  ): Promise<StoredTelegramAttachment> => {
    const scope = auth.groupType === "family_private"
      ? "family"
      : auth.groupType === "external"
        ? "group"
        : null;
    if (scope === null) {
      throw new AppError(
        "AGENT_TELEGRAM_ATTACHMENT_SCOPE_FORBIDDEN",
        "Вложения можно импортировать только из зарегистрированной группы",
      );
    }
    const reference = await dependencies.findAttachment(auth, attachmentId);
    const stored = await dependencies.persist({
      attachments: [reference.attachment],
      auth,
      chatId: reference.chatId,
      messageId: reference.messageId,
      scope,
    });
    const attachment = stored[0];
    if (!attachment) {
      throw new Error(
        "AGENT_TELEGRAM_ATTACHMENT_MATERIALIZATION_EMPTY: Telegram-вложение не было сохранено в workspace",
      );
    }
    return attachment;
  };
}

const workspaceAttachmentImporter = createTelegramWorkspaceAttachmentImporter({
  download: downloadTelegramAttachment,
  writeBinary: workspaceBinaryRepository.writeBinary,
});

export const materializeTelegramAttachment = createTelegramAttachmentMaterializer({
  findAttachment: telegramGroupAttachmentRepository.find,
  persist: workspaceAttachmentImporter.persist,
});
