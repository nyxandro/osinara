/**
 * Secure Telegram rendering for Eve HITL input requests.
 *
 * Exports:
 * - `createTelegramInputRequestHandler`: dependency-injected renderer and durable approval binder.
 * - `handleTelegramInputRequested`: production Eve `input.requested` event handler.
 */
import {
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  type TelegramEventContext,
} from "eve/channels/telegram";
import type { SessionContext } from "eve/context";

import {
  localizeTelegramInputRequest,
  localizeTelegramReplyMarkup,
  type TelegramInputRequest,
} from "../telegram-interface.js";
import { AppError } from "../app-error.js";
import { applicationSessionId, rekeyTelegramSession } from "../sessions/session-context.js";
import { sessionRepository } from "../sessions/session-repository.js";
import {
  telegramHitlApprovalRepository,
  type TelegramHitlApprovalRepository,
} from "./approval-repository.js";

interface InputRequestedData {
  requests: readonly TelegramInputRequest[];
}

interface InputRequestDependencies {
  approvals: Pick<TelegramHitlApprovalRepository, "register">;
  markPendingOperation(id: string, pending: boolean): Promise<void>;
  rekey(channel: TelegramEventContext, ctx: Pick<SessionContext, "session">): Promise<void>;
}

const HITL_PREPARING_MESSAGE = "Подготавливаю безопасный запрос подтверждения.";

type TelegramJsonValue =
  | boolean
  | null
  | number
  | string
  | { readonly [key: string]: TelegramJsonValue }
  | readonly TelegramJsonValue[];

function toTelegramJson(value: unknown): TelegramJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) return value;
  if (Array.isArray(value)) return value.map(toTelegramJson);
  if (typeof value !== "object") {
    throw new AppError(
      "AGENT_APPROVAL_MARKUP_INVALID",
      "Не удалось подготовить безопасные кнопки подтверждения",
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toTelegramJson(item)]),
  );
}

function callbackData(replyMarkup: Readonly<Record<string, unknown>> | undefined): string[] {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    return row.flatMap((button) => {
      if (!button || typeof button !== "object") return [];
      const value = (button as Record<string, unknown>).callback_data;
      return typeof value === "string" ? [value] : [];
    });
  });
}

export function createTelegramInputRequestHandler(dependencies: InputRequestDependencies) {
  return async function handleInputRequested(
    data: InputRequestedData,
    channel: TelegramEventContext,
    ctx: Pick<SessionContext, "session">,
  ): Promise<void> {
    const appSessionId = applicationSessionId(ctx);
    const caller = ctx.session.auth.current;
    const telegramUserId = caller?.attributes.telegramUserId;
    const chatId = channel.state.chatId;
    const chatType = channel.state.chatType;
    if (
      caller?.authenticator !== "telegram" ||
      typeof telegramUserId !== "string" ||
      !chatId ||
      (chatType !== "group" && chatType !== "private" && chatType !== "supergroup")
    ) {
      throw new AppError(
        "AGENT_APPROVAL_CONTEXT_INVALID",
        "Не удалось безопасно привязать подтверждение к пользователю Telegram",
      );
    }

    await dependencies.markPendingOperation(appSessionId, true);
    for (const request of data.requests) {
      const localizedRequest = localizeTelegramInputRequest(request);
      const rendered = renderTelegramInputRequest(localizedRequest, channel.state);
      const replyMarkup = localizeTelegramReplyMarkup(rendered.replyMarkup);
      const callbacks = callbackData(replyMarkup);

      // The actionable prompt is revealed only after both the route and approver binding are durable.
      const sent = await channel.telegram.post({
        ...(callbacks.length === 0 ? { reply_markup: replyMarkup } : {}),
        text: HITL_PREPARING_MESSAGE,
      });
      if (!sent.id) {
        throw new AppError(
          "AGENT_APPROVAL_MESSAGE_INVALID",
          "Telegram не вернул идентификатор запроса подтверждения",
        );
      }
      await dependencies.rekey(channel, ctx);
      await dependencies.approvals.register({
        applicationSessionId: appSessionId,
        callbackData: callbacks,
        eveSessionId: ctx.session.id,
        requestId: localizedRequest.requestId,
        telegramChatId: chatId,
        telegramChatType: chatType,
        telegramMessageId: sent.id,
        telegramMessageThreadId: channel.state.messageThreadId === null
          ? null
          : String(channel.state.messageThreadId),
        telegramUserId,
      });
      if (rendered.freeformRequestId) {
        registerTelegramFreeformPrompt(channel.state, {
          messageId: sent.id,
          requestId: rendered.freeformRequestId,
        });
      }
      const edited = await channel.telegram.request("editMessageText", {
        chat_id: chatId,
        message_id: Number(sent.id),
        ...(channel.state.messageThreadId === null
          ? {}
          : { message_thread_id: channel.state.messageThreadId }),
        ...(callbacks.length > 0 ? { reply_markup: toTelegramJson(replyMarkup) } : {}),
        text: rendered.text,
      });
      if (!edited.ok) {
        throw new AppError(
          "AGENT_APPROVAL_MESSAGE_EDIT_FAILED",
          "Telegram не показал подготовленный запрос подтверждения. Повторите действие",
        );
      }
    }
  };
}

export const handleTelegramInputRequested = createTelegramInputRequestHandler({
  approvals: telegramHitlApprovalRepository,
  markPendingOperation: (id, pending) => sessionRepository.markPendingOperation(id, pending),
  rekey: rekeyTelegramSession,
});
