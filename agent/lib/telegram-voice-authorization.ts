/**
 * Telegram voice authorization boundary.
 *
 * Exports:
 * - `createTelegramVoiceAuthorizer`: checks current family/group access before Groq usage.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import { evaluateConversationAccess } from "./family-access.js";
import type { TelegramRepository } from "./telegram-repository.js";

type VoiceAuthorizationMessage = Pick<TelegramMessage, "chat" | "from">;

export function createTelegramVoiceAuthorizer(
  repository: Pick<TelegramRepository, "findGroup" | "findIdentity">,
) {
  return async function authorizeVoice(message: VoiceAuthorizationMessage): Promise<boolean> {
    const sender = message.from;
    if (!sender || sender.isBot || message.chat.type === "channel") return false;

    // Authorization is re-evaluated when the durable item is claimed, before provider usage.
    const identity = await repository.findIdentity(sender.id);
    const registeredGroup =
      message.chat.type === "private" ? null : await repository.findGroup(message.chat.id);
    return evaluateConversationAccess({
      chat: { id: message.chat.id, type: message.chat.type },
      identity,
      registeredGroup,
    }).allowed;
  };
}
