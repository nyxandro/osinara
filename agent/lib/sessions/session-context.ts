/**
 * Trusted application session context helpers.
 *
 * Exports:
 * - `applicationSessionId`: reads the application-owned ID from persisted verified auth.
 * - `rekeyTelegramSession`: records the current Telegram anchor and re-keys Eve atomically.
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

export async function rekeyTelegramSession(
  channel: TelegramEventContext,
  ctx: Pick<SessionContext, "session">,
): Promise<void> {
  const state = channel.state;
  if (!state.chatId) {
    throw new AppError("AGENT_SESSION_ROUTE_INVALID", "Не удалось определить Telegram-чат контекста");
  }

  // The Telegram adapter can change the group anchor after every outbound message.
  const baseToken = telegramContinuationToken({
    chatId: state.chatId,
    ...(state.chatType === "private" || state.conversationId === null
      ? {}
      : { conversationId: state.conversationId }),
    ...(state.messageThreadId === null ? {} : { messageThreadId: state.messageThreadId }),
  });
  const sessionId = applicationSessionId(ctx);
  const token = await sessionRepository.registerRoute(sessionId, baseToken);
  channel.setContinuationToken(token);
}
