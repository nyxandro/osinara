/**
 * Which runtime session a Telegram conversation address belongs to.
 *
 * Exports:
 * - `openTelegramSession`: the session of an address; a new address gets a new session, opened by
 *   the sender of its first message, with the channel state that message described.
 * - `requireTelegramSession`: a session addressed by id, which must exist.
 * - `telegramInitialState`: the channel state of a conversation nobody has written to yet.
 *
 * Eve kept the same rule in its channel addresses (`createChannelAddress`): only a new message may
 * create a session, the state passed with it applies only then, and later messages keep the
 * session's stored state. Callers run these inside their own transaction.
 */
import { AppError } from "../../lib/app-error.js";
import type { SessionAuthContext } from "../context.js";
import { createSessionHistory, type HistoryClient } from "../history/history-repository.js";
import { newSessionId } from "../ids.js";
import { bindContinuation, findContinuation } from "../session/continuations.js";
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
  // One transaction per address at a time: two first messages must not open two sessions.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${TELEGRAM_CHANNEL_KIND}:${input.token}`]);
  const existing = await findContinuation(client, { channelKind: TELEGRAM_CHANNEL_KIND, token: input.token });
  if (existing !== null) return existing;
  const applicationSessionId = input.auth.attributes.applicationSessionId;
  if (typeof applicationSessionId !== "string") {
    throw new AppError("AGENT_SESSION_CONTEXT_INVALID", "Не удалось определить текущий контекст разговора");
  }
  const sessionId = newSessionId();
  await createSessionHistory(client, {
    announcedSkills: null,
    applicationSessionId,
    channelState: { ...input.state },
    compaction: { inputTokens: null, promptMessageCount: null },
    history: [],
    initiatorAuth: input.auth,
    parentSessionId: null,
    sandbox: null,
    sessionId,
    source: "runtime",
    todo: null,
  });
  await bindContinuation(client, { channelKind: TELEGRAM_CHANNEL_KIND, sessionId, token: input.token });
  return sessionId;
}

export async function requireTelegramSession(client: HistoryClient, sessionId: string): Promise<string> {
  const row = await client.query("SELECT 1 FROM agent_session_state WHERE session_id = $1", [sessionId]);
  if (row.rowCount !== 1) {
    throw new AppError("AGENT_TELEGRAM_RESPONSE_SESSION_INACTIVE", "Разговор, к которому относится ответ, больше не активен. Отправьте сообщение заново");
  }
  return sessionId;
}
