/**
 * Trusted Telegram reply-target policy.
 *
 * Exports:
 * - `TelegramReplyParameters`: Bot API payload for one verified message reply.
 * - `telegramTurnReplyParameters`: resolves a group reply from current session auth.
 */
import type { TelegramChannelState } from "eve/channels/telegram";
import type { SessionContext } from "eve/context";

import { AppError } from "./app-error.js";

const POSITIVE_MESSAGE_ID_PATTERN = /^[1-9]\d*$/u;

export interface TelegramReplyParameters {
  readonly [key: string]: boolean | number;
  readonly allow_sending_without_reply: true;
  readonly message_id: number;
}

export function telegramTurnReplyParameters(
  state: Pick<TelegramChannelState, "chatId" | "chatType">,
  ctx: Pick<SessionContext, "session">,
): TelegramReplyParameters | undefined {
  // Private chats are already one-to-one; callback turns intentionally omit the message-origin key.
  if (state.chatType !== "group" && state.chatType !== "supergroup") return undefined;
  const auth = ctx.session.auth.current;
  const replyToMessageId = auth?.attributes.telegramReplyToMessageId;
  if (!auth || replyToMessageId === undefined) return undefined;

  // Reply metadata may only cross the channel boundary when it belongs to this exact verified chat.
  if (
    auth.authenticator !== "telegram" ||
    auth.attributes.telegramChatId !== state.chatId ||
    auth.attributes.telegramChatType !== state.chatType ||
    typeof replyToMessageId !== "string" ||
    !POSITIVE_MESSAGE_ID_PATTERN.test(replyToMessageId)
  ) {
    throw new AppError(
      "AGENT_TELEGRAM_REPLY_CONTEXT_INVALID",
      "Не удалось безопасно привязать ответ к сообщению Telegram",
    );
  }
  const numericMessageId = Number(replyToMessageId);
  if (!Number.isSafeInteger(numericMessageId)) {
    throw new AppError(
      "AGENT_TELEGRAM_REPLY_CONTEXT_INVALID",
      "Не удалось безопасно привязать ответ к сообщению Telegram",
    );
  }
  return { allow_sending_without_reply: true, message_id: numericMessageId };
}
