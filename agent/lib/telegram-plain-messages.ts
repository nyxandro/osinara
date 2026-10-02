/**
 * Native ordinary Telegram text delivery.
 *
 * Export:
 * - `postTelegramPlainMessageChunk`: sends one provider-sized text chunk without parse mode.
 */
import { TELEGRAM_MESSAGE_TEXT_MAX_LENGTH } from "../runtime/telegram/api.js";
import type { TelegramEventContext } from "../runtime/telegram/channel-types.js";

import { AppError } from "./app-error.js";
import type { TelegramReplyParameters } from "./telegram-reply.js";
import type { SentTelegramMessage } from "./telegram-rich-messages.js";
import { postTelegramMessageWithReceiptWithoutContinuationChange } from "./telegram-stable-delivery.js";

export async function postTelegramPlainMessageChunk(
  text: string,
  channel: TelegramEventContext,
  replyParameters?: TelegramReplyParameters,
): Promise<SentTelegramMessage> {
  if (!text || text.length > TELEGRAM_MESSAGE_TEXT_MAX_LENGTH) {
    throw new AppError(
      "AGENT_TELEGRAM_PLAIN_MESSAGE_INPUT_INVALID",
      "Обычное сообщение превышает допустимый размер Telegram",
    );
  }

  // Proactive sessions have no inbound chat type. The raw provider receipt supplies the verified
  // type without mutating Eve's continuation anchor before the durable receipt is committed.
  return await postTelegramMessageWithReceiptWithoutContinuationChange(channel, {
    ...(replyParameters === undefined ? {} : { reply_parameters: replyParameters }),
    text,
  });
}
