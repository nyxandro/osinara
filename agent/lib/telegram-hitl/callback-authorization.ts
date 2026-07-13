/**
 * Telegram HITL callback authorization boundary.
 *
 * Exports:
 * - `createTelegramHitlCallbackAuthorizer`: builds an independently testable callback guard.
 * - `authorizeTelegramHitlCallback`: production guard backed by durable PostgreSQL claims.
 */
import type {
  TelegramCallbackQuery,
  TelegramContext,
  TelegramInboundResult,
} from "eve/channels/telegram";

import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./approval-repository.js";

const CALLBACK_ERRORS = {
  expired:
    "AGENT_APPROVAL_EXPIRED: Это подтверждение уже использовано или больше не действует.",
  forbidden:
    "AGENT_APPROVAL_FORBIDDEN: Подтвердить действие может только пользователь, который его запросил.",
} as const;

export function createTelegramHitlCallbackAuthorizer(
  repository: Pick<TelegramHitlApprovalRepository, "claimCallback">,
) {
  return async function authorizeHitlCallback(
    ctx: TelegramContext,
    query: TelegramCallbackQuery,
    continuationToken: string,
  ): Promise<TelegramInboundResult> {
    const message = query.message;
    const callbackData = query.data;
    if (!message || !callbackData) {
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        showAlert: true,
        text: CALLBACK_ERRORS.expired,
      });
      return null;
    }

    // The repository atomically binds the exact button, active Eve request, and current DB role.
    const result = await repository.claimCallback({
      baseContinuationToken: continuationToken,
      callbackData,
      telegramChatId: message.chat.id,
      telegramMessageId: message.messageId,
      telegramUserId: query.from.id,
    });
    if (result.status === "authorized") {
      return { auth: result.auth, continuationToken: result.continuationToken };
    }

    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      showAlert: true,
      text: CALLBACK_ERRORS[result.status],
    });
    return null;
  };
}

export const authorizeTelegramHitlCallback = createTelegramHitlCallbackAuthorizer(
  telegramHitlApprovalRepository,
);
