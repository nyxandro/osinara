/**
 * Trusted application session context helpers.
 *
 * Exports:
 * - `applicationSessionId`: reads the application-owned ID from persisted verified auth.
 * - `resolveApplicationSessionId`: supports a pre-rollout pending generation-zero callback.
 * - `rekeyTelegramSession`: records the current Telegram anchor and re-keys Eve atomically.
 */
import type { TelegramEventContext } from "eve/channels/telegram";
import { telegramContinuationToken } from "eve/channels/telegram";
import type { SessionContext } from "eve/context";

import { AppError } from "../app-error.js";
import { sessionRepository } from "./session-repository.js";

export function applicationSessionId(ctx: Pick<SessionContext, "session">): string {
  // HITL callbacks have no current caller, but the verified initiator remains durable in Eve.
  const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
  const id = auth?.attributes.applicationSessionId;
  if (typeof id !== "string") {
    throw new AppError(
      "AGENT_SESSION_CONTEXT_INVALID",
      "Не удалось определить текущий контекст разговора",
    );
  }
  return id;
}

export async function resolveApplicationSessionId(
  ctx: Pick<SessionContext, "session">,
  continuationToken: string,
): Promise<string> {
  const auth = ctx.session.auth.current ?? ctx.session.auth.initiator;
  const id = auth?.attributes.applicationSessionId;
  if (typeof id === "string") return id;
  const restored = await sessionRepository.findIdByContinuationToken(continuationToken);
  if (restored) return restored;
  throw new AppError(
    "AGENT_SESSION_CONTEXT_INVALID",
    "Не удалось восстановить старый контекст. Отправьте запрос новым сообщением",
  );
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
  const sessionId = await resolveApplicationSessionId(ctx, channel.continuationToken);
  const token = await sessionRepository.registerRoute(sessionId, baseToken);
  channel.setContinuationToken(token);
}
