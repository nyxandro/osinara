/**
 * A look at the current Telegram avatar of a chat participant through the vision model.
 *
 * Exports:
 * - `TelegramAvatarInspectionDependencies`: the author lookup, the avatar source and the analysis.
 * - `inspectTelegramAvatar`: the avatar branch of `inspect_workspace_image`.
 *
 * Key constructs:
 * - The person is named by the number of one of their messages in the current chat, the `#N` the
 *   model sees in the timeline: a number names one author exactly, a name could name two.
 * - The scope is the current chat's own and is checked before live access to it: a scope of another
 *   chat would otherwise come back as a refused access the model must not retry, not as a slip it
 *   can correct.
 * - The bytes live only in memory for the vision call: nothing is written to the workspace, so
 *   there is nothing to clean up, and the next look fetches the avatar again.
 * - A person without a visible avatar is an answer the agent passes on, not a failure.
 */
import { VISION_MAX_FILE_BYTES } from "../../config.js";
import { AppError } from "../app-error.js";
import { validateVisionImageBytes } from "../attachments/telegram-vision-attachment.js";
import { ModelFacingError } from "../model-facing-error.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "../workspaces/workspace-repository.js";
import type { TelegramAvatarAuthor } from "./telegram-avatar-author-repository.js";
import type { TelegramAvatarSource } from "./telegram-avatar-source.js";

export interface TelegramAvatarInspectionDependencies {
  analyze(input: { abortSignal?: AbortSignal; bytes: Uint8Array; mediaType: string; question: string }): Promise<string>;
  authorizeScope(auth: WorkspaceAuthorization, scope: WorkspaceScope): Promise<void>;
  findAuthor(auth: WorkspaceAuthorization, sequenceId: string): Promise<TelegramAvatarAuthor | null>;
  source: TelegramAvatarSource;
}

const MISSING_AVATAR_REASON = "У этого человека нет аватарки или она скрыта от ботов настройками приватности Telegram.";

function chatScope(auth: WorkspaceAuthorization): WorkspaceScope {
  if (auth.telegramChatType === "private") return "personal";
  if (auth.groupType === "family_private") return "family";
  if (auth.groupType === "external") return "group";
  throw new AppError("AGENT_TELEGRAM_AVATAR_CONTEXT_INVALID", "Аватарки доступны только внутри проверенного чата");
}

export async function inspectTelegramAvatar(
  dependencies: TelegramAvatarInspectionDependencies,
  auth: WorkspaceAuthorization,
  input: { abortSignal?: AbortSignal; avatarOfSequence: string; question: string; scope: WorkspaceScope },
) {
  const scope = chatScope(auth);
  if (input.scope !== scope) {
    throw new ModelFacingError({
      category: "input",
      code: "AGENT_TELEGRAM_AVATAR_SCOPE_INVALID",
      correction: `Повторите вызов с scope "${scope}": аватарку смотрят в области текущего чата.`,
      example: { avatarOfSequence: input.avatarOfSequence, question: input.question, scope },
      field: "scope",
      reason: "Аватарку смотрят только в области текущего чата.",
      retryable: true,
      sideEffectStatus: "not_started",
    });
  }
  await dependencies.authorizeScope(auth, scope);
  const author = await dependencies.findAuthor(auth, input.avatarOfSequence);
  if (author === null) {
    throw new ModelFacingError({
      category: "not_found",
      code: "AGENT_TELEGRAM_AVATAR_SOURCE_NOT_FOUND",
      correction: "Возьмите номер любого сообщения этого человека в текущем чате (#N в ленте или sourceSequence текущего сообщения) и повторите.",
      field: "avatarOfSequence",
      reason: "В этом чате нет сообщения с таким номером.",
      retryable: true,
      sideEffectStatus: "not_started",
    });
  }
  // A channel posts under the channel's name and the agent's own messages have no participant behind them.
  if ((author.actorKind !== "user" && author.actorKind !== "telegram_bot") || author.telegramUserId === null) {
    throw new ModelFacingError({
      category: "input",
      code: "AGENT_TELEGRAM_AVATAR_NOT_A_PERSON",
      correction: "Не повторяйте вызов с этим номером. Скажите, что это сообщение написал канал или сам агент, а не участник чата.",
      field: "avatarOfSequence",
      reason: "Это сообщение написал не участник чата, а канал или сам агент.",
      retryable: false,
      sideEffectStatus: "not_started",
    });
  }
  const person = {
    avatarOfSequence: input.avatarOfSequence,
    kind: "telegram_avatar" as const,
    senderDisplayName: author.senderDisplayName,
    senderUsername: author.senderUsername,
  };
  const lookup = await dependencies.source.lookup(author.telegramUserId);
  if (lookup.status === "none") {
    console.info(JSON.stringify({ actorKind: author.actorKind, avatar: "missing", code: "AGENT_TELEGRAM_AVATAR_INSPECTED" }));
    return { avatar: "missing" as const, reason: MISSING_AVATAR_REASON, scope, source: person };
  }
  const bytes = await dependencies.source.download(lookup.photo);
  if (bytes.byteLength > VISION_MAX_FILE_BYTES) {
    throw new AppError("AGENT_WORKSPACE_VISION_FILE_TOO_LARGE", "Vision-модель принимает изображение размером не более 10 МБ");
  }
  const mediaType = await validateVisionImageBytes(bytes);
  const analysis = await dependencies.analyze({
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
  console.info(JSON.stringify({ actorKind: author.actorKind, avatar: "found", code: "AGENT_TELEGRAM_AVATAR_INSPECTED" }));
  return { analysis, scope, source: { ...person, mediaType, size: bytes.byteLength } };
}
