/**
 * Lazy authorized Telegram attachment materialization.
 *
 * Exports:
 * - `createTelegramAttachmentMaterializer`: resolves one opaque reference and persists its bytes; a file
 *   that did not come through is a refusal the model reads and explains to the person in its own words.
 * - `materializeTelegramAttachment`: production registered-group journal to workspace pipeline.
 */
import type { TelegramAttachment } from "../../runtime/telegram/inbound.js";

import { telegramGroupAttachmentRepository } from "./telegram-group-attachment-repository.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { AppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import type { UnreceivedFileReason } from "../unreceived-telegram-files.js";
import { extractAnimationStill } from "./animation-still.js";
import { downloadTelegramAttachment } from "./telegram-attachment-download.js";
import {
  createTelegramWorkspaceAttachmentImporter,
  type StoredTelegramAttachment,
  type TelegramAttachmentImport,
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
  }): Promise<TelegramAttachmentImport[]>;
}

const UNRECEIVED_FILE_REFUSALS: Readonly<Record<UnreceivedFileReason, { code: string; correction: string; reason: string }>> = {
  picture_unavailable: {
    code: "AGENT_ANIMATION_STILL_UNAVAILABLE",
    correction: "Не повторяйте вызов. Скажите человеку прямо, что не видите эту гифку, и не гадайте, что на ней.",
    reason: "Сервер не смог получить кадр из файла этой гифки.",
  },
  telegram_failure: {
    code: "AGENT_ATTACHMENT_DOWNLOAD_FAILED",
    correction: "Не повторяйте вызов. Своими словами, без кодов, скажите человеку, что Telegram глючит и файл не дошёл, " +
      "и попросите прислать его ещё раз; если так уже не вышло раньше в этом чате, предложите попробовать чуть позже.",
    reason: "Telegram не отдал боту файл — сбой на стороне Telegram.",
  },
  too_large: {
    code: "AGENT_ATTACHMENT_DOWNLOAD_TOO_LARGE",
    correction: "Не повторяйте вызов. Своими словами предложите человеку прислать файл поменьше, частями или ссылкой.",
    reason: "Файл больше 20 МБ: такой Telegram боту не отдаёт.",
  },
};

// Expected: the importer already logged the file that did not come, and the model only passes it on.
function unreceivedFileRefusal(reason: UnreceivedFileReason): ModelFacingError {
  return new ModelFacingError({
    category: "dependency",
    ...UNRECEIVED_FILE_REFUSALS[reason],
    retryable: false,
    sideEffectStatus: "not_started",
  }, { isExpectedRefusal: true });
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
    if ("unreceived" in attachment) throw unreceivedFileRefusal(attachment.unreceived);
    return attachment;
  };
}

const workspaceAttachmentImporter = createTelegramWorkspaceAttachmentImporter({
  download: downloadTelegramAttachment,
  extractAnimationStill,
  writeBinary: workspaceBinaryRepository.writeBinary,
});

export const materializeTelegramAttachment = createTelegramAttachmentMaterializer({
  findAttachment: telegramGroupAttachmentRepository.find,
  persist: workspaceAttachmentImporter.persist,
});
