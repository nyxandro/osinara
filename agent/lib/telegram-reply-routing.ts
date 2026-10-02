/**
 * Telegram reply continuation routing.
 *
 * Exports:
 * - `telegramBaseContinuationToken`: selects a verified route or derives the native Eve base token.
 * - `telegramReplyContinuationTokens`: returns exact and reviewed historical reply-route candidates.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";
import { telegramContinuationToken } from "../runtime/telegram/api.js";

export function telegramBaseContinuationToken(
  message: TelegramMessage,
  verifiedReplyRoute?: string,
): string {
  if (verifiedReplyRoute !== undefined) return verifiedReplyRoute;

  // A first reply in a forum can acquire a new thread ID; route by the referenced bot anchor.
  const repliesToBot = message.replyToMessage?.from?.isBot === true;
  const conversationId = repliesToBot
    ? message.replyToMessage.messageId
    : message.chat.type === "private"
    ? undefined
    : message.messageId;
  const messageThreadId = repliesToBot
    ? message.replyToMessage?.messageThreadId
    : message.messageThreadId;
  return telegramContinuationToken({
    chatId: message.chat.id,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
  });
}

export function telegramReplyContinuationTokens(message: TelegramMessage): string[] {
  const reply = message.replyToMessage;
  if (!reply) return [];

  // Prefer the exact topic route; retain only the persisted pre-v0.2.17 threadless route candidate.
  const messageThreadId = reply.messageThreadId ?? message.messageThreadId;
  const exact = telegramContinuationToken({
    chatId: message.chat.id,
    conversationId: reply.messageId,
    ...(messageThreadId === undefined ? {} : { messageThreadId }),
  });
  if (messageThreadId === undefined) return [exact];
  return [exact, telegramContinuationToken({
    chatId: message.chat.id,
    conversationId: reply.messageId,
  })];
}
