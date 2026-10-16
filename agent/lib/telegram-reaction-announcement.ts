/**
 * Announcement of the reaction set to the model.
 *
 * Exports:
 * - `REACTION_SET_OPEN_TAG`: block name the standing reaction rules point at.
 * - `formatReactionSetAnnouncement`: the history message that names the current set.
 * - `announcesReactionSet`: whether that exact message is still present in history.
 *
 * Key construct:
 * - The set is a user-role history message, so it is authored once and travels with the session.
 *   Announcing it again is driven purely by absence: a changed set renders a different message, and
 *   compaction that replaced the old one also removes it, so both cases resolve to one rule.
 */
import type { ModelMessage } from "ai";

export const REACTION_SET_OPEN_TAG = "<telegram_chat_reactions>";
const REACTION_SET_CLOSE_TAG = "</telegram_chat_reactions>";

export function formatReactionSetAnnouncement(reactions: readonly string[]): string {
  return [
    REACTION_SET_OPEN_TAG,
    `Telegram accepts only these reactions in this chat: ${reactions.join(" ")}`,
    REACTION_SET_CLOSE_TAG,
  ].join("\n");
}

export function announcesReactionSet(
  messages: readonly ModelMessage[],
  announcement: string,
): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") return message.content.includes(announcement);
    return message.content.some(
      (part) => part.type === "text" && part.text.includes(announcement),
    );
  });
}
