/**
 * Telegram ordinary-reply and HITL authorization boundary.
 *
 * Exports:
 * - `TelegramReplyAuthorizationResult`: accepted routing state for the remaining inbound turn.
 * - `authorizeTelegramReply`: separates channel conversation replies from human HITL approvals.
 */
import type { TelegramMessage } from "eve/channels/telegram";

import type { TelegramHitlApprovalRepository } from "./telegram-hitl/approval-repository.js";
import type { TelegramInboundActor } from "./telegram-inbound-actor.js";
import { isReplyToBot } from "./telegram-message-policy.js";
import { telegramBaseContinuationToken } from "./telegram-reply-routing.js";

export interface TelegramReplyAuthorizationResult {
  accepted: boolean;
  replyHandling: "message" | undefined;
  resumesPendingTask: boolean;
  verifiedReplyRoute: string | undefined;
}

export async function authorizeTelegramReply(input: {
  ingress?: { updateId: string; dispatchId: string };
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
  // Eve synthesizes HITL responses for replies to any bot unless explicitly told otherwise.
  // Only a DB-authorized human reply may leave the ordinary-message path.
  let replyHandling: "message" | undefined = "message";
  let resumesPendingTask = false;
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
      ...(input.ingress ? { ingress: input.ingress } : {}),
      baseContinuationToken: telegramBaseContinuationToken(
        input.message,
        verifiedReplyRoute ?? (input.replyToAgent ? input.exactReplyRoute : undefined),
      ),
      telegramChatId: input.message.chat.id,
      telegramMessageId: replyTarget.messageId,
      telegramUserId: input.actor.id,
    });
    if (authorization === "forbidden" || authorization === "expired") {
      const error = authorization === "forbidden"
        ? "AGENT_APPROVAL_FORBIDDEN: Подтвердить действие может только пользователь, который его запросил."
        : "AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.";
      if (input.message.chat.type === "private") await input.sendMessage(error);
      return { accepted: false, replyHandling, resumesPendingTask, verifiedReplyRoute };
    }

    // DB authorization decides synthetic HITL. A verified ordinary reply keeps its conversation route.
    const ordinaryAgentReply = input.replyToAgent || input.message.chat.type === "private" ||
      isReplyToBot(input.message, input.botUsername);
    if (authorization === "not_applicable" && ordinaryAgentReply) {
      if (!input.hasResumableReplyRoute) verifiedReplyRoute = input.exactReplyRoute;
    }
    if (authorization === "authorized") {
      replyHandling = undefined;
      resumesPendingTask = true;
    }
  }

  return { accepted: true, replyHandling, resumesPendingTask, verifiedReplyRoute };
}
