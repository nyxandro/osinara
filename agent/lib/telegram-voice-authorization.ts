/**
 * Telegram voice authorization boundary.
 *
 * Exports:
 * - `createTelegramVoiceAuthorizer`: whether a voice note or a video note goes to transcription.
 *
 * A private chat and the family group transcribe every one of a family member. An external group
 * transcribes only one addressed to the agent, and in owner-only mode only the owner's: the rest of
 * its talk stays a placeholder with its length, and nobody else's voice leaves for the provider.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

import { evaluateConversationAccess } from "./family-access.js";
import type { TelegramRepository } from "./telegram-repository.js";

type VoiceAuthorizationMessage = Pick<TelegramMessage, "chat" | "from">;

export function createTelegramVoiceAuthorizer(
  repository: Pick<TelegramRepository, "findGroup" | "findIdentity">,
) {
  return async function authorizeVoice(
    message: VoiceAuthorizationMessage,
    options: { readonly addressed: boolean },
  ): Promise<boolean> {
    const sender = message.from;
    if (!sender || sender.isBot || message.chat.type === "channel") return false;

    // Private voice is allowed only for a current family identity.
    if (message.chat.type === "private") {
      const identity = await repository.findIdentity(sender.id);
      return evaluateConversationAccess({
        actorKind: "telegram_user",
        chat: { id: message.chat.id, type: message.chat.type },
        identity,
        registeredGroup: null,
      }).allowed;
    }

    // Resolve group trust before identity: an unregistered chat's voice never reaches the provider.
    const registeredGroup = await repository.findGroup(message.chat.id, message.chat.type);
    if (!registeredGroup) return false;
    if (registeredGroup.type === "external") {
      if (!options.addressed) return false;
      if (registeredGroup.messageMode !== "owner_only") return true;
      const owner = await repository.findIdentity(sender.id);
      return owner?.familyId === registeredGroup.familyId && owner.role === "owner";
    }
    const identity = await repository.findIdentity(sender.id);
    return evaluateConversationAccess({
      actorKind: "telegram_user",
      chat: { id: message.chat.id, type: message.chat.type },
      identity,
      registeredGroup,
    }).allowed;
  };
}
