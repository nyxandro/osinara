/**
 * Trusted Telegram inbox path construction.
 *
 * Export:
 * - `telegramInboxDirectory`: derives a collision-free inbox directory from authorized scope data.
 */
import { AppError } from "../app-error.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "../workspaces/workspace-repository.js";

export function telegramInboxDirectory(
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
  telegramMessageId: string,
): string {
  // A personal workspace belongs to one Telegram identity, so its chat-local message ID is unique.
  if (scope === "personal") return `inbox/${telegramMessageId}`;

  // A family can register multiple private groups. The trusted group UUID prevents equal chat-local
  // message IDs from resolving or overwriting another group's attachment in the shared workspace.
  if (scope === "family" && auth.groupType === "family_private" && auth.groupId !== null) {
    return `inbox/groups/${auth.groupId}/${telegramMessageId}`;
  }

  throw new AppError(
    "AGENT_TELEGRAM_ATTACHMENT_SCOPE_FORBIDDEN",
    "Вложения Telegram можно сохранять только в личном или зарегистрированном семейном чате",
  );
}
