/**
 * Authorized workspace and ephemeral Telegram vision boundary.
 *
 * Exports:
 * - `createWorkspaceImageInspector`: validates and submits authorized image bytes.
 * - `inspectWorkspaceImage`: production server-configured protocol-native vision inspector.
 *
 * The current Telegram avatar of a chat participant is one more source; its branch lives in
 * `telegram-avatars/telegram-avatar-inspection.ts` and shares this live scope check and analysis.
 */
import { VISION_MAX_FILE_BYTES } from "../../config.js";
import { analyzeImageWithVisionModel } from "../vision-model-analysis.js";
import { AppError, isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import { downloadTelegramAttachment } from "../attachments/telegram-attachment-download.js";
import { telegramGroupAttachmentRepository } from "../attachments/telegram-group-attachment-repository.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import {
  type TelegramAvatarAuthor,
  telegramAvatarAuthorRepository,
} from "../telegram-avatars/telegram-avatar-author-repository.js";
import { inspectTelegramAvatar } from "../telegram-avatars/telegram-avatar-inspection.js";
import { type TelegramAvatarSource, telegramAvatarSource } from "../telegram-avatars/telegram-avatar-source.js";
import {
  type WorkspaceBinaryFile,
  workspaceBinaryRepository,
} from "./workspace-binary-repository.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspace-repository.js";

interface ImageAnalysisInput {
  abortSignal?: AbortSignal;
  bytes: Uint8Array;
  mediaType: string;
  question: string;
}

interface WorkspaceImageInspectorDependencies {
  analyze(input: ImageAnalysisInput): Promise<string>;
  authorizeScope(auth: WorkspaceAuthorization, scope: WorkspaceScope): Promise<void>;
  avatarSource: TelegramAvatarSource;
  downloadTelegramAttachment: typeof downloadTelegramAttachment;
  findAvatarAuthor(auth: WorkspaceAuthorization, sequenceId: string): Promise<TelegramAvatarAuthor | null>;
  findTelegramAttachment: typeof telegramGroupAttachmentRepository.find;
  readBinary(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    path: string,
  ): Promise<WorkspaceBinaryFile>;
  readTelegramInboxAttachment(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    telegramMessageId: string,
  ): Promise<WorkspaceBinaryFile>;
}

type WorkspaceImageLocation =
  | { attachmentId: string }
  | { avatarOfSequence: string }
  | { path: string }
  | { telegramMessageId: string };

function assertAttachmentScope(auth: WorkspaceAuthorization, scope: WorkspaceScope): void {
  const allowed = auth.groupType === "family_private" && scope === "family" ||
    auth.groupType === "external" && scope === "group";
  if (!allowed) {
    throw new AppError(
      "AGENT_TELEGRAM_ATTACHMENT_ACCESS_DENIED",
      "Вложение недоступно в текущей группе и области файлов",
    );
  }
}

async function analyzeImage(
  dependencies: WorkspaceImageInspectorDependencies,
  input: ImageAnalysisInput,
): Promise<string> {
  try {
    return await dependencies.analyze(input);
  } catch (error) {
    if (isAppError(error)) throw error;
    console.error(JSON.stringify({
      code: "AGENT_WORKSPACE_VISION_PROVIDER_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
    throw new ModelFacingError({
      category: "dependency",
      code: "AGENT_WORKSPACE_VISION_PROVIDER_FAILED",
      correction: "Не повторяйте анализ автоматически. Сообщите, что анализ изображения временно недоступен.",
      reason: "Vision-модель завершила анализ с внутренней ошибкой.",
      retryable: false,
      sideEffectStatus: "not_started",
    });
  }
}

export function createWorkspaceImageInspector(
  dependencies: WorkspaceImageInspectorDependencies,
) {
  return async (
    auth: WorkspaceAuthorization,
    input: {
      abortSignal?: AbortSignal;
      question: string;
      scope: WorkspaceScope;
    } & WorkspaceImageLocation,
  ) => {
    // Capability changes must not bypass the same live scope authorization used by file reads.
    await dependencies.authorizeScope(auth, input.scope);

    if ("avatarOfSequence" in input) {
      return await inspectTelegramAvatar({
        analyze: (analysis) => analyzeImage(dependencies, analysis),
        findAuthor: dependencies.findAvatarAuthor,
        source: dependencies.avatarSource,
      }, auth, input);
    }

    if ("attachmentId" in input) {
      assertAttachmentScope(auth, input.scope);
      const reference = await dependencies.findTelegramAttachment(auth, input.attachmentId);
      if (reference.attachment.size !== undefined &&
        reference.attachment.size > VISION_MAX_FILE_BYTES) {
        throw new AppError(
          "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE",
          "Vision-модель принимает изображение размером не более 10 МБ",
        );
      }
      const bytes = await dependencies.downloadTelegramAttachment(reference.attachment);
      if (bytes.byteLength > VISION_MAX_FILE_BYTES) {
        throw new AppError(
          "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE",
          "Vision-модель принимает изображение размером не более 10 МБ",
        );
      }
      const mediaType = await validateVisionImageBytes(bytes);
      const analysis = await analyzeImage(dependencies, {
        ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
        bytes,
        mediaType,
        question: input.question,
      });
      if (!analysis.trim()) {
        throw new AppError(
          "AGENT_WORKSPACE_VISION_RESPONSE_EMPTY",
          "Vision-модель не смогла описать изображение. Уточните вопрос и попробуйте снова",
        );
      }
      return {
        analysis,
        scope: input.scope,
        source: {
          attachmentId: input.attachmentId,
          kind: reference.attachment.kind,
          mediaType,
          size: bytes.byteLength,
          telegramMessageId: reference.messageId,
        },
      };
    }

    const binary = "telegramMessageId" in input
      ? await dependencies.readTelegramInboxAttachment(
        auth,
        input.scope,
        input.telegramMessageId,
      )
      : await dependencies.readBinary(auth, input.scope, input.path);
    if (!binary.file.mediaType.startsWith("image/")) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED",
        "Vision-модель может повторно открыть из workspace только файл изображения",
      );
    }
    if (binary.bytes.byteLength > VISION_MAX_FILE_BYTES) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE",
        "Vision-модель принимает изображение размером не более 10 МБ",
      );
    }
    const analysis = await analyzeImage(dependencies, {
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      bytes: binary.bytes,
      mediaType: binary.file.mediaType,
      question: input.question,
    });
    if (!analysis.trim()) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_RESPONSE_EMPTY",
        "Vision-модель не смогла описать изображение. Уточните вопрос и попробуйте снова",
      );
    }
    return { analysis, path: binary.file.path, scope: binary.file.scope };
  };
}

export const inspectWorkspaceImage = createWorkspaceImageInspector({
  analyze: analyzeImageWithVisionModel,
  authorizeScope: workspaceBinaryRepository.authorizeScope,
  avatarSource: telegramAvatarSource,
  downloadTelegramAttachment,
  findAvatarAuthor: telegramAvatarAuthorRepository.find,
  findTelegramAttachment: telegramGroupAttachmentRepository.find,
  readBinary: workspaceBinaryRepository.readBinary,
  readTelegramInboxAttachment: workspaceBinaryRepository.readTelegramInboxAttachment,
});
