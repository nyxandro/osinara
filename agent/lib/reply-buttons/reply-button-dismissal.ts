/**
 * The addressee wrote instead of tapping: their buttons go away.
 *
 * Exports:
 * - `createReplyButtonDismissal`: dismissal over the repository and Telegram.
 * - `dismissReplyButtonsOnMessage`: the production dismissal.
 * - `hasReplyButtonsToDismiss`: whether the message's author has buttons on screen in its chat.
 *
 * Key constructs:
 * - Only the addressee's own message counts. Another participant's message, the bot's next message
 *   and a reminder leave the buttons alone.
 * - Only buttons that were visible before the message was written go: a set the agent offered
 *   after it, in answer to it, stays. So does a set whose tap came before the message and still
 *   waits to be decided: the two can be decided out of order, and the tap was first.
 * - The recorded dismissal is the decision; editing each message is presentation, and one failed
 *   edit does not stop the others.
 */
import type { TelegramMessage } from "../../runtime/telegram/inbound.js";

import { AppError } from "../app-error.js";
import { DISMISSED_REPLY_CAPTION } from "./reply-button-contract.js";
import { replyButtonRepository } from "./reply-button-repository.js";
import { replyButtonTelegram, type ReplyButtonTelegram } from "./reply-button-telegram.js";

interface ReplyButtonDismissalDependencies {
  repository: Pick<typeof replyButtonRepository, "dismissForAddressee">;
  telegram: Pick<ReplyButtonTelegram, "settle">;
}

function writtenAt(message: TelegramMessage): Date {
  const date = message.raw.date;
  if (typeof date !== "number" || !Number.isSafeInteger(date) || date <= 0) {
    throw new AppError("AGENT_TELEGRAM_MESSAGE_DATE_INVALID", "Telegram передал сообщение без времени отправки");
  }
  return new Date(date * 1_000);
}

export function createReplyButtonDismissal(dependencies: ReplyButtonDismissalDependencies) {
  return async function dismissReplyButtonsOnMessage(message: TelegramMessage, updateId: string): Promise<void> {
    if (message.from === undefined || message.from.isBot) return;
    const dismissed = await dependencies.repository.dismissForAddressee({
      addresseeTelegramUserId: message.from.id,
      afterUpdateId: updateId,
      telegramChatId: message.chat.id,
      writtenAt: writtenAt(message),
    });
    for (const set of dismissed) {
      try {
        await dependencies.telegram.settle(set, DISMISSED_REPLY_CAPTION);
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_REPLY_BUTTONS_SETTLE_FAILED",
          error: error instanceof Error ? error.message : String(error),
          setId: set.id,
        }));
      }
    }
  };
}

export async function hasReplyButtonsToDismiss(message: TelegramMessage): Promise<boolean> {
  if (message.from === undefined || message.from.isBot) return false;
  return await replyButtonRepository.hasActiveForAddressee({
    addresseeTelegramUserId: message.from.id,
    telegramChatId: message.chat.id,
  });
}

export const dismissReplyButtonsOnMessage = createReplyButtonDismissal({
  repository: replyButtonRepository,
  telegram: replyButtonTelegram,
});
