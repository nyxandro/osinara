/**
 * Telegram channel context handed to the application's channel handlers.
 *
 * Exports:
 * - `TELEGRAM_CHANNEL_KIND`: the channel kind Telegram conversation addresses are bound under.
 * - `TelegramHandle`: Bot API calls bound to one chat, as `ctx.telegram`.
 * - `TelegramContext`, `TelegramEventContext`: handler contexts before and inside a session.
 * - `TelegramTurnContext`, `TelegramTurnEvents`: the application's handlers of a Telegram turn.
 * - `TelegramChannelState`: JSON state of one Telegram conversation, including pending prompts.
 * - `TelegramInboundResult`, `TelegramHitlCallbackResult`: what the application's message and
 *   button handlers decide.
 *
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import type { SessionAuth, SessionAuthContext, SessionTurn } from "../context.js";
import type { InputRequest, InputResponse } from "../hitl/types.js";
import type { JsonObject } from "../json.js";
import type { TelegramApiResponse, TelegramMessageBody, TelegramMessageResult } from "./api.js";
import type { TelegramChatType } from "./inbound.js";

/** The channel kind of Telegram conversations; addresses are bound under it. */
export const TELEGRAM_CHANNEL_KIND = "telegram";

export interface TelegramHandle {
  readonly botUsername: string | undefined;
  readonly chatId: string;
  readonly chatType: TelegramChatType | undefined;
  readonly conversationId: string | undefined;
  readonly messageThreadId: number | undefined;

  request(method: string, body?: JsonObject): Promise<TelegramApiResponse>;
  /** Same as `sendMessage`: text over the 4096-character cap goes out as several messages. */
  post(message: string | TelegramMessageBody): Promise<TelegramMessageResult>;
  sendMessage(message: string | TelegramMessageBody): Promise<TelegramMessageResult>;
  /** Sends a chat action (default `typing`); a failure is logged, never thrown. */
  startTyping(action?: string): Promise<void>;
  answerCallbackQuery(input: {
    readonly callbackQueryId: string;
    readonly showAlert?: boolean;
    readonly text?: string;
  }): Promise<TelegramApiResponse>;
  editMessageReplyMarkup(input: {
    readonly messageId: number | string;
    readonly replyMarkup?: Readonly<Record<string, unknown>>;
  }): Promise<TelegramApiResponse>;
}

/** Context before a session exists: message and callback hooks. */
export interface TelegramContext {
  readonly telegram: TelegramHandle;
}

export interface TelegramHitlState {
  hitlCallbacks?: Record<string, InputResponse>;
  nextHitlCallbackId?: number;
  pendingFreeformReplies?: Record<string, string>;
}

export interface TelegramChannelState extends TelegramHitlState {
  /** Bot username used for group mention detection. */
  botUsername?: string | null;
  chatId: string | null;
  chatType: TelegramChatType | null;
  /** Group conversation anchor message id. */
  conversationId: string | null;
  /** Forum topic id, when the conversation lives in an explicit topic. */
  messageThreadId: number | null;
  /** Telegram user who triggered the current turn. */
  triggeringUserId?: string | null;
}

/**
 * Context of a handler that runs for a turn event. Changes to `state` are saved after the handler.
 * The address is read-only: the runtime never re-addresses a session after a bot message; the
 * application keeps its own routes.
 */
export interface TelegramEventContext extends TelegramContext {
  readonly continuation?: { readonly token: string };
  state: TelegramChannelState;
}

/** The turn a handler runs for. */
export interface TelegramTurnContext {
  readonly session: {
    readonly auth: SessionAuth;
    readonly id: string;
    readonly parent?: undefined;
    readonly turn: SessionTurn;
  };
}

type TelegramTurnHandler<TData> = (data: TData, channel: TelegramEventContext, ctx: TelegramTurnContext) => Promise<void>;

/**
 * The application's handlers of a Telegram turn. A thrown error fails the turn, except in
 * `turn.completed`, `turn.failed` and `turn.cancelled`, which run after the outcome is stored.
 */
export interface TelegramTurnEvents {
  /** Before the turn's instructions are resolved; a failure stops the turn before any model call. */
  readonly "turn.started": TelegramTurnHandler<Record<string, never>>;
  /** The text of one model step; `message: null` is a deliberate silence. */
  readonly "message.completed": TelegramTurnHandler<{ readonly finishReason: string; readonly message: string | null; readonly stepIndex: number }>;
  /** Tools of a step start running; without a handler the chat shows "typing". */
  readonly "actions.requested"?: TelegramTurnHandler<{ readonly stepIndex: number }>;
  /** The turn waits for these requests; it is already parked. */
  readonly "input.requested": TelegramTurnHandler<{ readonly requests: readonly InputRequest[] }>;
  /** The turn ended with an answer, or parked for a person. */
  readonly "turn.completed": TelegramTurnHandler<{ readonly status: "completed" | "waiting_input" }>;
  readonly "turn.failed": TelegramTurnHandler<{ readonly code: string; readonly message: string }>;
  readonly "turn.cancelled": TelegramTurnHandler<Record<string, never>>;
}

/** Message hook decision; `null` drops the update. */
export type TelegramInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly continuationToken?: string;
  /** Replaces only what the model sees, e.g. a merged burst or a voice transcript. */
  readonly message?: string;
  /** `"message"` makes a reply to a bot message an ordinary message, not an answer to a prompt. */
  readonly replyHandling?: "message";
  readonly title?: string;
} | null;

/** Button hook decision after application authentication; `null` ignores the press. */
export type TelegramHitlCallbackResult = {
  readonly acknowledgementText?: string;
  readonly auth: SessionAuthContext | null;
  readonly continuationToken?: string;
} | null;
