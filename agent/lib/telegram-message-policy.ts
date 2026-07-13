/**
 * Telegram group dispatch policy.
 *
 * Exports:
 * - `isMessageAddressedToBot`: preserves private, command, mention, and reply behavior.
 */
interface TelegramDispatchMessage {
  chat: {
    id?: string;
    type: "channel" | "group" | "private" | "supergroup";
  };
  replyToMessage?: {
    from?: {
      id?: string;
      isBot: boolean;
      username?: string;
    };
  };
  text: string;
}

const TELEGRAM_COMMAND_PATTERN =
  /^\/(?<command>[A-Za-z0-9_]+)(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u;
const TELEGRAM_MENTION_PATTERN = /(?:^|[^A-Za-z0-9_])@(?<target>[A-Za-z0-9_]+)/gu;

export function isMessageAddressedToBot(
  message: TelegramDispatchMessage,
  botUsername: string,
): boolean {
  // Private messages are direct by definition; channels never dispatch to the agent.
  if (message.chat.type === "private") return true;
  if (message.chat.type === "channel") return false;

  // Telegram commands start at the first character; an explicit suffix must name this bot.
  const commandMatch = TELEGRAM_COMMAND_PATTERN.exec(message.text);
  const commandTarget = commandMatch?.groups?.target;
  if (commandMatch && (!commandTarget || commandTarget.toLowerCase() === botUsername.toLowerCase())) {
    return true;
  }

  // Mentions and replies must target the complete username of this bot, not another bot.
  const addressedByMention = Array.from(message.text.matchAll(TELEGRAM_MENTION_PATTERN)).some(
    (match) => match.groups?.target?.toLowerCase() === botUsername.toLowerCase(),
  );
  if (addressedByMention) return true;
  return Boolean(
    message.replyToMessage?.from?.isBot &&
      message.replyToMessage.from.username?.toLowerCase() === botUsername.toLowerCase(),
  );
}
