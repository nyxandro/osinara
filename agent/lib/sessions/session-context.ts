/**
 * Trusted application session context helpers.
 *
 * Exports:
 * - `applicationSessionId`: reads the application-owned ID from persisted verified auth.
 * - `registerTelegramDeliveredMessageRoutes`: stores channel-delivered message IDs as aliases.
 * - `registerTelegramMessageRoutes`: binds every tool-delivered message to one app session.
 * - `sandboxSessionId`: reads the stable conversation-thread ID for disposable compute.
 */
import type { TelegramEventContext } from "eve/channels/telegram";
import { telegramContinuationToken } from "eve/channels/telegram";
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { sessionRepository } from "./session-repository.js";

export function applicationSessionId(ctx: Pick<SessionContext, "session">): string {
  const auth = ctx.session.auth.current;
  const id = auth?.attributes.applicationSessionId;
  if (typeof id !== "string") {
    throw new AppError(
      "AGENT_SESSION_CONTEXT_INVALID",
      "Не удалось определить текущий контекст разговора",
    );
  }
  return id;
}

export function sandboxSessionId(ctx: Pick<SessionContext, "session">): string {
  const id = ctx.session.auth.current?.attributes.sandboxSessionId;
  if (typeof id !== "string") {
    throw new AppError(
      "AGENT_SANDBOX_SESSION_CONTEXT_INVALID",
      "Не удалось определить изолированную среду текущего разговора",
    );
  }
  return id;
}

function telegramMessageThreadId(
  stateThreadId: number | null,
  ctx: Pick<SessionContext, "session">,
): number | undefined {
  if (stateThreadId !== null) return stateThreadId;
  const verifiedThreadId = ctx.session.auth.current?.attributes.telegramMessageThreadId;
  if (verifiedThreadId === undefined) return undefined;
  const parsed = Number(verifiedThreadId);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError(
      "AGENT_SESSION_ROUTE_INVALID",
      "Не удалось определить тему Telegram для продолжения контекста",
    );
  }
  return parsed;
}

export async function registerTelegramDeliveredMessageRoutes(
  channel: TelegramEventContext,
  ctx: Pick<SessionContext, "session">,
  deliveredMessageIds: readonly string[],
): Promise<void> {
  const state = channel.state;
  if (!state.chatId) {
    throw new AppError("AGENT_SESSION_ROUTE_INVALID", "Не удалось определить Telegram-чат контекста");
  }

  // Delivery anchors are application aliases only. Private HITL callbacks need their exact message
  // route too; Eve's continuation token remains stable so no delivery can claim a competing hook.
  const messageThreadId = telegramMessageThreadId(state.messageThreadId, ctx);
  const sessionId = applicationSessionId(ctx);
  for (const conversationId of deliveredMessageIds) {
    if (!/^[1-9][0-9]*$/u.test(conversationId)) {
      throw new AppError(
        "AGENT_SESSION_ROUTE_INVALID",
        "Telegram вернул некорректный идентификатор доставленного сообщения",
      );
    }
    const baseToken = telegramContinuationToken({
      chatId: state.chatId,
      conversationId,
      ...(messageThreadId === undefined ? {} : { messageThreadId }),
    });
    await sessionRepository.registerRouteAlias(sessionId, baseToken);
  }
}

export async function registerTelegramMessageRoutes(input: {
  applicationSessionId: string;
  chatId: string;
  messageIds: readonly string[];
  messageThreadId?: number;
}): Promise<void> {
  // Tool deliveries bypass channel state, so each confirmed Telegram ID receives an explicit alias.
  for (const conversationId of input.messageIds) {
    if (!/^[1-9][0-9]*$/u.test(conversationId)) {
      throw new AppError(
        "AGENT_SESSION_ROUTE_INVALID",
        "Telegram вернул некорректный идентификатор доставленного сообщения",
      );
    }
    const baseToken = telegramContinuationToken({
      chatId: input.chatId,
      conversationId,
      ...(input.messageThreadId === undefined ? {} : { messageThreadId: input.messageThreadId }),
    });
    await sessionRepository.registerRouteAlias(input.applicationSessionId, baseToken);
  }
}
