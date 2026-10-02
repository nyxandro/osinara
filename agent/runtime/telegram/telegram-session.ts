/**
 * Which runtime session a Telegram conversation address belongs to.
 *
 * Exports:
 * - `openTelegramSession`: the session of an address; a new address gets a new session, opened by
 *   the sender of its first message, with the channel state that message described.
 * - `requireTelegramSession`: a session addressed by id, which must exist.
 * - `telegramInitialState`: the channel state of a conversation nobody has written to yet.
 *
 * The rule is the channel sessions' (`session/channel-session.ts`): only a new message may create a
 * session, the state passed with it applies only then, and later messages keep the session's
 * stored state. Callers run these inside their own transaction.
 */
import { AppError } from "../../lib/app-error.js";
import type { SessionAuthContext } from "../context.js";
import type { HistoryClient } from "../history/history-repository.js";
import { openChannelSession } from "../session/channel-session.js";
import { TELEGRAM_CHANNEL_KIND, type TelegramChannelState } from "./channel-types.js";

export function telegramInitialState(botUsername: string | undefined): TelegramChannelState {
  return {
    botUsername: botUsername ?? null,
    chatId: null,
    chatType: null,
    conversationId: null,
    hitlCallbacks: {},
    messageThreadId: null,
    nextHitlCallbackId: 0,
    pendingFreeformReplies: {},
    triggeringUserId: null,
  };
}

export async function openTelegramSession(client: HistoryClient, input: {
  readonly auth: SessionAuthContext;
  readonly state: TelegramChannelState;
  readonly token: string;
}): Promise<string> {
  return await openChannelSession(client, {
    auth: input.auth, channelKind: TELEGRAM_CHANNEL_KIND, channelState: { ...input.state }, token: input.token,
  });
}

export async function requireTelegramSession(client: HistoryClient, sessionId: string): Promise<string> {
  const row = await client.query("SELECT 1 FROM agent_session_state WHERE session_id = $1", [sessionId]);
  if (row.rowCount !== 1) {
    throw new AppError("AGENT_TELEGRAM_RESPONSE_SESSION_INACTIVE", "Разговор, к которому относится ответ, больше не активен. Отправьте сообщение заново");
  }
  return sessionId;
}
