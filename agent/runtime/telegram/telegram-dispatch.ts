/**
 * Telegram updates into turns: an incoming message and a pressed button.
 *
 * Exports:
 * - `dispatchTelegramMessage`, `dispatchTelegramCallback`: run the application's hook, then, in one
 *   transaction, find or open the conversation's session and create the turn the update asks for.
 *   The caller runs that turn (`dispatch.ts`).
 * - `TelegramChannelHooks`: the application's decisions about messages and buttons.
 * - `TelegramDispatchControl`: what the verified ingress adds — its own preparation, attributes of
 *   the turn's auth, a record of the created turn in the same transaction, and a stop signal.
 * - `TelegramDispatchResult`: the turn to run (for a partial answer, the turn that keeps waiting),
 *   or nothing.
 * - `continuationTokenFromState`, `turnChannel`: a conversation's address and a turn's channel.
 * - `replyInputResponse`: the answer a reply to a bot message carries, if it carries one.
 *
 * Ported from eve 0.40.0 `public/channels/telegram/telegramChannel.ts` (`dispatchMessage`,
 * `dispatchCallbackQuery`, `stateFromMessage`, `stateFromCallbackQuery`,
 * `conversationIdForMessage`, `continuationTokenFromState`, `attachTelegramDeliver`) with Osinara's
 * patches (`scripts/apply-eve-patches.ts`, `scripts/eve-patches/telegram-dispatch-control.ts`):
 * - bot senders reach the application hook, which decides; hook failures reach the caller;
 * - `message` replaces only the model-visible text, `continuationToken` the address;
 * - `replyHandling: "message"` makes a reply to a bot message an ordinary message;
 * - a button is acknowledged only after the application authorized it, with its text;
 * - `osinaraTelegramResponseSessionId` addresses an answer to an exact session;
 * - a dispatch without verified auth is refused.
 * Changes: Eve queued the delivery for its workflow; here the turn is created in a transaction and
 * the caller runs it. A text message answers the session's waiting requests when it matches them
 * (Eve's `resolveTextMessageInput`); answers to requests that no longer wait reach the model as a
 * user message (Eve's `convertStaleResponsesToUserMessage`).
 */
import { AppError } from "../../lib/app-error.js";
import type { SessionAuth, SessionAuthContext } from "../context.js";
import { loadInitiatorAuth } from "../history/history-repository.js";
import { resolveTextToResponses, staleResponsesMessage } from "../hitl/answer-matching.js";
import type { InputResponse } from "../hitl/types.js";
import { findContinuation, loadChannelState, saveChannelState } from "../session/continuations.js";
import { findInputRequests, inJournalTransaction, type JournalClient, type JournalDatabase } from "../turn/journal-repository.js";
import { respondWithClient, startTurnWithClient, waitingRequests } from "../turn/turn-start.js";
import type { TurnChannel } from "../turn/turn-types.js";
import { telegramContinuationToken } from "./api.js";
import {
  TELEGRAM_CHANNEL_KIND, type TelegramChannelState, type TelegramContext, type TelegramHitlCallbackResult,
  type TelegramInboundResult,
} from "./channel-types.js";
import { buildTelegramHandle, type TelegramTransport } from "./handle.js";
import {
  isTelegramHitlCallback, isTelegramSyntheticResponse, resolveTelegramInputResponses, telegramCallbackInputResponse,
  telegramReplyInputResponse,
} from "./hitl.js";
import { formatTelegramContextBlock, type TelegramCallbackQuery, type TelegramMessage } from "./inbound.js";
import { openTelegramSession, requireTelegramSession, telegramInitialState } from "./telegram-session.js";

export interface TelegramChannelHooks {
  readonly botUsername: string;
  readonly onHitlCallbackQuery: (ctx: TelegramContext, query: TelegramCallbackQuery, token: string) => Promise<TelegramHitlCallbackResult>;
  readonly onMessage: (ctx: TelegramContext, message: TelegramMessage) => Promise<TelegramInboundResult>;
  readonly transport: TelegramTransport;
}

export interface TelegramDispatchTarget {
  readonly sessionId: string;
  /**
   * The turn to run. A partial answer names the waiting turn that recorded it: running it returns
   * its stored outcome.
   */
  readonly turnId: string;
}

export interface TelegramDispatchControl {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly bind?: (client: JournalClient, target: TelegramDispatchTarget) => Promise<void>;
  readonly prepareCallback?: (
    ctx: TelegramContext, query: TelegramCallbackQuery, token: string, prepare: TelegramChannelHooks["onHitlCallbackQuery"],
  ) => Promise<TelegramHitlCallbackResult>;
  readonly prepareMessage?: (
    ctx: TelegramContext, message: TelegramMessage, prepare: TelegramChannelHooks["onMessage"],
  ) => Promise<TelegramInboundResult>;
  /** Once aborted, no turn is created: a preparation that outlived its deadline starts nothing. */
  readonly signal?: AbortSignal;
}

export type TelegramDispatchResult =
  | { readonly status: "dropped" }
  | ({ readonly status: "dispatched" } & TelegramDispatchTarget);

const DROPPED: TelegramDispatchResult = { status: "dropped" };
const CALLBACK_ACKNOWLEDGEMENT = "Answer received.";
const UNSUPPORTED_CALLBACK_ACKNOWLEDGEMENT = "Unsupported action.";

function stateFromMessage(message: TelegramMessage, botUsername: string): TelegramChannelState {
  const privateChat = message.chat.type === "private";
  return {
    ...telegramInitialState(botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    // A reply to the bot continues the conversation the bot's message anchored.
    conversationId: privateChat ? null : message.replyToMessage?.from?.isBot === true ? message.replyToMessage.messageId : message.messageId,
    messageThreadId: message.messageThreadId ?? null,
    triggeringUserId: message.from?.id ?? null,
  };
}

function stateFromCallbackQuery(query: TelegramCallbackQuery, botUsername: string): TelegramChannelState {
  const message = query.message;
  if (!message) return { ...telegramInitialState(botUsername), triggeringUserId: query.from.id };
  return {
    ...telegramInitialState(botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    conversationId: message.chat.type === "private" ? null : message.messageId,
    messageThreadId: message.messageThreadId ?? null,
    triggeringUserId: query.from.id,
  };
}

/** The address of a conversation state; a private chat is addressed by its chat alone. */
export function continuationTokenFromState(state: TelegramChannelState): string {
  return telegramContinuationToken({
    chatId: state.chatId ?? "",
    conversationId: state.chatType === "private" ? undefined : (state.conversationId ?? undefined),
    messageThreadId: state.messageThreadId ?? undefined,
  });
}

function verifiedAuth(auth: SessionAuthContext | null, control: TelegramDispatchControl): SessionAuthContext {
  if (auth === null) {
    throw new AppError("AGENT_TELEGRAM_DISPATCH_AUTH_MISSING", "Не удалось проверить отправителя сообщения");
  }
  return control.attributes === undefined ? auth : { ...auth, attributes: { ...auth.attributes, ...control.attributes } };
}

export function turnChannel(token: string, state: TelegramChannelState): TurnChannel {
  return {
    continuationToken: token,
    kind: TELEGRAM_CHANNEL_KIND,
    metadata: { chatId: state.chatId, chatType: state.chatType, triggeringUserId: state.triggeringUserId ?? null },
  };
}

async function sessionState(client: JournalClient, sessionId: string, forUpdate = false): Promise<TelegramChannelState> {
  const state = await loadChannelState<TelegramChannelState>(client, sessionId, { forUpdate });
  if (state === null) {
    throw new AppError("AGENT_TELEGRAM_CHANNEL_STATE_MISSING", "Не удалось восстановить состояние разговора Telegram", { details: { sessionId } });
  }
  return state;
}

async function turnAuth(client: JournalClient, sessionId: string, current: SessionAuthContext): Promise<SessionAuth> {
  return { current, initiator: await loadInitiatorAuth(client, sessionId) };
}

/** An answer goes to its exact session, or to the session that owns the address. */
async function answeredSession(client: JournalClient, auth: SessionAuthContext, token: string): Promise<string> {
  const exact = auth.attributes.osinaraTelegramResponseSessionId;
  if (typeof exact === "string") return await requireTelegramSession(client, exact);
  const owner = await findContinuation(client, { channelKind: TELEGRAM_CHANNEL_KIND, token });
  if (owner === null) {
    throw new AppError("AGENT_TELEGRAM_RESPONSE_SESSION_MISSING", "Не найден разговор, к которому относится ответ. Отправьте сообщение заново");
  }
  return owner;
}

async function dispatched(client: JournalClient, control: TelegramDispatchControl, target: TelegramDispatchTarget): Promise<TelegramDispatchResult> {
  control.signal?.throwIfAborted();
  await control.bind?.(client, target);
  return { status: "dispatched", ...target };
}

async function respond(client: JournalClient, input: {
  readonly auth: SessionAuthContext;
  readonly context: readonly string[];
  readonly control: TelegramDispatchControl;
  readonly responses: readonly InputResponse[];
  readonly sessionId: string;
  readonly token: string;
}): Promise<TelegramDispatchResult> {
  const { control, sessionId } = input;
  const state = await sessionState(client, sessionId, true);
  let responses = [...input.responses];
  if (responses.some(isTelegramSyntheticResponse)) {
    // A pressed button's short id is spent: a second press of it maps to nothing.
    responses = resolveTelegramInputResponses(state, responses);
    await saveChannelState(client, sessionId, state);
  }
  if (responses.length === 0) return DROPPED;
  const auth = await turnAuth(client, sessionId, input.auth);
  const channel = turnChannel(input.token, state);
  const outcome = await respondWithClient(client, { auth, context: input.context, responses, sessionId });
  if (outcome.status !== "stale" && outcome.stale.length > 0) {
    console.warn(JSON.stringify({
      code: "AGENT_TELEGRAM_STALE_RESPONSES_IGNORED", requestIds: outcome.stale.map((response) => response.requestId), sessionId,
    }));
  }
  if (outcome.status === "resumed") return await dispatched(client, control, { sessionId, turnId: outcome.continuation.id });
  if (outcome.status === "waiting") return await dispatched(client, control, { sessionId, turnId: outcome.turnId });
  // Every answer is for a request that no longer waits: the model hears it as new input, and it
  // never authorizes the earlier action.
  const requests = await findInputRequests(client, sessionId, outcome.stale.map((response) => response.requestId));
  const turn = await startTurnWithClient(client, {
    auth, channel, input: { context: input.context, message: staleResponsesMessage(outcome.stale, requests) },
    kind: "conversation", parent: null, sessionId,
  });
  return await dispatched(client, control, { sessionId, turnId: turn.id });
}

/**
 * A non-empty reply to a bot message answers the prompt that message carried, unless the
 * application marked it an ordinary message (Eve's rule with Osinara's `replyHandling` patch).
 */
export function replyInputResponse(message: TelegramMessage, result: NonNullable<TelegramInboundResult>): InputResponse | undefined {
  const text = message.text || message.caption;
  return result.replyHandling !== "message" && message.replyToMessage?.from?.isBot === true && text.trim().length > 0
    ? telegramReplyInputResponse({ messageId: message.replyToMessage.messageId, text })
    : undefined;
}

async function acknowledge(ctx: TelegramContext, callbackQueryId: string, text: string): Promise<void> {
  try {
    await ctx.telegram.answerCallbackQuery({ callbackQueryId, text });
  } catch (error) {
    // The acknowledgement only stops the button's spinner; the answer itself still counts.
    console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_CALLBACK_ACK_FAILED", error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function dispatchTelegramMessage(
  database: JournalDatabase,
  hooks: TelegramChannelHooks,
  message: TelegramMessage,
  control: TelegramDispatchControl = {},
): Promise<TelegramDispatchResult> {
  const state = stateFromMessage(message, hooks.botUsername);
  const ctx: TelegramContext = { telegram: buildTelegramHandle({ state, transport: hooks.transport }) };
  const result = control.prepareMessage === undefined
    ? await hooks.onMessage(ctx, message)
    : await control.prepareMessage(ctx, message, hooks.onMessage);
  if (result === null) return DROPPED;
  control.signal?.throwIfAborted();
  const auth = verifiedAuth(result.auth, control);
  const context = [
    formatTelegramContextBlock({
      botUsername: hooks.botUsername,
      chatId: message.chat.id,
      chatTitle: message.chat.title,
      chatType: message.chat.type,
      messageId: message.messageId,
      messageThreadId: message.messageThreadId,
      userId: message.from?.id,
      username: message.from?.username,
    }),
    ...(result.context ?? []),
  ];
  const text = message.text || message.caption;
  const token = result.continuationToken ?? continuationTokenFromState(state);
  const reply = replyInputResponse(message, result);
  return await inJournalTransaction(database, async (client) => {
    if (reply !== undefined) {
      const sessionId = await answeredSession(client, auth, token);
      return await respond(client, { auth, context, control, responses: [reply], sessionId, token });
    }
    const exact = auth.attributes.osinaraTelegramResponseSessionId;
    const sessionId = typeof exact === "string"
      ? await requireTelegramSession(client, exact)
      : await openTelegramSession(client, { auth, state, token });
    const turnMessage = result.message ?? text;
    const waiting = await waitingRequests(client, sessionId);
    const answers = waiting.length === 0 ? [] : resolveTextToResponses(turnMessage, waiting);
    if (answers.length > 0) return await respond(client, { auth, context, control, responses: answers, sessionId, token });
    const turn = await startTurnWithClient(client, {
      auth: await turnAuth(client, sessionId, auth),
      channel: turnChannel(token, await sessionState(client, sessionId)),
      input: { context, message: turnMessage },
      kind: "conversation",
      parent: null,
      sessionId,
    });
    return await dispatched(client, control, { sessionId, turnId: turn.id });
  });
}

export async function dispatchTelegramCallback(
  database: JournalDatabase,
  hooks: TelegramChannelHooks,
  query: TelegramCallbackQuery,
  control: TelegramDispatchControl = {},
): Promise<TelegramDispatchResult> {
  const state = stateFromCallbackQuery(query, hooks.botUsername);
  const ctx: TelegramContext = { telegram: buildTelegramHandle({ state, transport: hooks.transport }) };
  const data = query.data;
  if (!isTelegramHitlCallback(data)) {
    await acknowledge(ctx, query.id, UNSUPPORTED_CALLBACK_ACKNOWLEDGEMENT);
    return DROPPED;
  }
  if (!query.message || !state.chatId) return DROPPED;
  const token = continuationTokenFromState(state);
  const result = control.prepareCallback === undefined
    ? await hooks.onHitlCallbackQuery(ctx, query, token)
    : await control.prepareCallback(ctx, query, token, hooks.onHitlCallbackQuery);
  // A press the application rejected is not acknowledged and never continues a turn.
  if (result === null) return DROPPED;
  await acknowledge(ctx, query.id, result.acknowledgementText ?? CALLBACK_ACKNOWLEDGEMENT);
  control.signal?.throwIfAborted();
  const auth = verifiedAuth(result.auth, control);
  const address = result.continuationToken ?? token;
  return await inJournalTransaction(database, async (client) => {
    const sessionId = await answeredSession(client, auth, address);
    // A button adds no channel context between the approval and the tool it releases.
    return await respond(client, { auth, context: [], control, responses: [telegramCallbackInputResponse(data)], sessionId, token: address });
  });
}
