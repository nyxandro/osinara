/**
 * Telegram reply authorization boundary.
 *
 * Exports:
 * - `TelegramReplyAuthorizationResult`: accepted routing state for the remaining inbound turn.
 * - `authorizeTelegramReply`: accepts an ordinary reply to the bot, or refuses one aimed at a
 *   conversation whose approval no longer waits.
 */
import type { TelegramMessage } from "../runtime/telegram/inbound.js";

import type { TelegramHitlApprovalRepository } from "./telegram-hitl/approval-repository.js";
import type { TelegramInboundActor } from "./telegram-inbound-actor.js";
import { isReplyToBot } from "./telegram-message-policy.js";
import { telegramBaseContinuationToken } from "./telegram-reply-routing.js";

export interface TelegramReplyAuthorizationResult {
  accepted: boolean;
  verifiedReplyRoute: string | undefined;
}

export async function authorizeTelegramReply(input: {
  actor: TelegramInboundActor;
  botUsername: string;
  exactReplyRoute: string | undefined;
  hasResumableReplyRoute: boolean;
  hitl: Pick<TelegramHitlApprovalRepository, "authorizeReply">;
  message: TelegramMessage;
  replyToAgent: boolean;
  sendMessage(text: string): Promise<unknown>;
  verifiedReplyRoute: string | undefined;
}): Promise<TelegramReplyAuthorizationResult> {
  let verifiedReplyRoute = input.verifiedReplyRoute;
  const replyTarget = input.message.replyToMessage;

  // A channel or another bot can continue an ordinary group conversation, but neither owns the
  // account that requested a confirmation, so neither may ever approve a human action.
  if (input.actor.kind !== "telegram_user" &&
    (replyTarget?.from?.isBot === true || input.replyToAgent)) {
    if (input.replyToAgent || isReplyToBot(input.message, input.botUsername)) {
      if (!input.hasResumableReplyRoute) verifiedReplyRoute = input.exactReplyRoute;
    }
  } else if (replyTarget?.from?.isBot === true || input.replyToAgent) {
    if (!replyTarget) {
      throw new Error(
        "AGENT_TELEGRAM_REPLY_TARGET_MISSING: Для проверки ответа отсутствует Telegram-сообщение назначения",
      );
    }
    const authorization = await input.hitl.authorizeReply({
      baseContinuationToken: telegramBaseContinuationToken(
        input.message,
        verifiedReplyRoute ?? (input.replyToAgent ? input.exactReplyRoute : undefined),
      ),
      telegramChatId: input.message.chat.id,
      telegramMessageId: replyTarget.messageId,
      telegramUserId: input.actor.id,
    });
    if (authorization === "expired") {
      if (input.message.chat.type === "private") {
        await input.sendMessage("AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.");
      }
      return { accepted: false, verifiedReplyRoute };
    }

    // A verified ordinary reply keeps its conversation route.
    const ordinaryAgentReply = input.replyToAgent || input.message.chat.type === "private" ||
      isReplyToBot(input.message, input.botUsername);
    if (ordinaryAgentReply && !input.hasResumableReplyRoute) verifiedReplyRoute = input.exactReplyRoute;
  }

  return { accepted: true, verifiedReplyRoute };
}
