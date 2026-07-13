/**
 * Telegram voice authorization boundary.
 *
 * Exports:
 * - `createTelegramVoiceAuthorizer`: permits Groq usage only in personal and family spaces.
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

    // Private voice is allowed only for a current family identity.
    if (message.chat.type === "private") {
      const identity = await repository.findIdentity(sender.id);
      return evaluateConversationAccess({
        chat: { id: message.chat.id, type: message.chat.type },
        identity,
        registeredGroup: null,
      }).allowed;
    }

    // Resolve group trust before identity: external media must never reach Groq or Telegram getFile.
    const registeredGroup = await repository.findGroup(message.chat.id);
    if (!registeredGroup || registeredGroup.type !== "family_private") return false;
    const identity = await repository.findIdentity(sender.id);
    return evaluateConversationAccess({
      chat: { id: message.chat.id, type: message.chat.type },
      identity,
      registeredGroup,
    }).allowed;
  };
}
