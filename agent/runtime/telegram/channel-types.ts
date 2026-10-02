/**
 * Telegram channel context handed to the application's channel handlers.
 *
 * Exports:
 * - `TelegramHandle`: Bot API calls bound to one chat, as `ctx.telegram`.
 * - `TelegramContext`, `TelegramEventContext`: handler contexts before and inside a session.
 * - `TelegramChannelState`: JSON state of one Telegram conversation, including pending prompts.
 * - `TelegramInboundResult`, `TelegramHitlCallbackResult`: what the application's message and
 *   button handlers decide.
 *
 * Derived from eve 0.40.0 `public/channels/telegram/telegramChannel.ts`, `hitl.ts` and
 * `public/definitions/channel.ts` (Apache-2.0, see NOTICE-eve). Changes: the result types carry
 * the fields Osinara's patches added (`continuationToken`, `message`, `replyHandling`,
 * `acknowledgementText`).
 */
import type { SessionAuthContext } from "../context.js";
import type { InputResponse } from "../hitl/types.js";
import type { JsonObject } from "../json.js";
import type { TelegramApiResponse, TelegramMessageBody, TelegramMessageResult } from "./api.js";
import type { TelegramChatType } from "./inbound.js";

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

export interface ChannelContinuationOps {
  readonly continuation?: {
    readonly token: string;
    rekey(token: string): void;
  };
}

/** Context of a handler that runs for a session event. */
export interface TelegramEventContext extends TelegramContext, ChannelContinuationOps {
  state: TelegramChannelState;
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
