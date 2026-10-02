/**
 * The Telegram handle of one conversation: Bot API calls bound to its chat and topic.
 *
 * Export:
 * - `buildTelegramHandle`: `post`/`sendMessage` (split over the 4096-character cap, the first message
 *   returned), `startTyping` (never throws), callback answers, reply-markup edits and raw requests.
 *   A bot message in a group records itself as the conversation's anchor in the state.
 *
 * Ported from eve 0.40.0 `public/channels/telegram/telegramChannel.ts` (`buildTelegramHandle`,
 * `postTelegramMessage`) (Apache-2.0, see NOTICE-eve). Changes: the session is never re-addressed
 * after a bot message (Eve's `rekey`): Osinara keeps its own routes; a typing failure is logged as
 * one JSON line.
 */
import {
  answerTelegramCallbackQuery,
  callTelegramApi,
  editTelegramMessageReplyMarkup,
  sendTelegramChatAction,
  sendTelegramMessage,
  splitTelegramMessageText,
  type TelegramApiOptions,
  type TelegramMessageBody,
  type TelegramMessageResult,
} from "./api.js";
import type { TelegramChannelState, TelegramHandle } from "./channel-types.js";
import type { TelegramChatType } from "./inbound.js";

export interface TelegramTransport {
  readonly api?: Omit<TelegramApiOptions, "credentials">;
  readonly botUsername?: string;
  readonly credentials?: TelegramApiOptions["credentials"];
}

function anchorsConversation(chatType: TelegramChatType | null): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export function buildTelegramHandle(input: {
  readonly state: TelegramChannelState;
  readonly transport: TelegramTransport;
}): TelegramHandle {
  const { api, credentials } = input.transport;
  const state = input.state;

  function anchor(posted: TelegramMessageResult): void {
    const chatType = state.chatType ?? posted.chatType ?? null;
    if (state.chatType === null && posted.chatType !== undefined) state.chatType = posted.chatType;
    if (!posted.id || !anchorsConversation(chatType)) return;
    state.conversationId = posted.id;
  }

  async function sendOne(body: TelegramMessageBody): Promise<TelegramMessageResult> {
    const chatId = state.chatId ?? "";
    if (!chatId) throw new Error("AGENT_TELEGRAM_CHAT_MISSING: the conversation has no chat id for an outbound message");
    const posted = await sendTelegramMessage({
      apiBaseUrl: api?.apiBaseUrl,
      body: { ...body, message_thread_id: body.message_thread_id ?? state.messageThreadId ?? undefined },
      chatId,
      credentials,
      fetch: api?.fetch,
      fileBaseUrl: api?.fileBaseUrl,
    });
    anchor(posted);
    return posted;
  }

  async function post(message: string | TelegramMessageBody): Promise<TelegramMessageResult> {
    const body = typeof message === "string" ? { text: message } : message;
    let first: TelegramMessageResult | undefined;
    for (const [index, text] of splitTelegramMessageText(body.text).entries()) {
      const posted = await sendOne(index === 0 ? { ...body, text } : { text });
      first ??= posted;
    }
    return first ?? { id: "", raw: null };
  }

  return {
    botUsername: state.botUsername ?? input.transport.botUsername,
    chatId: state.chatId ?? "",
    chatType: state.chatType ?? undefined,
    conversationId: state.conversationId ?? undefined,
    messageThreadId: state.messageThreadId ?? undefined,
    answerCallbackQuery(query) {
      return answerTelegramCallbackQuery({
        apiBaseUrl: api?.apiBaseUrl, callbackQueryId: query.callbackQueryId, credentials, fetch: api?.fetch,
        showAlert: query.showAlert, text: query.text,
      });
    },
    editMessageReplyMarkup(args) {
      const chatId = state.chatId ?? "";
      if (!chatId) throw new Error("AGENT_TELEGRAM_CHAT_MISSING: the conversation has no chat id for a reply-markup edit");
      return editTelegramMessageReplyMarkup({
        apiBaseUrl: api?.apiBaseUrl, chatId, credentials, fetch: api?.fetch, messageId: args.messageId, replyMarkup: args.replyMarkup,
      });
    },
    post,
    request(method, body) {
      return callTelegramApi({ apiBaseUrl: api?.apiBaseUrl, body, botToken: credentials?.botToken, fetch: api?.fetch, method });
    },
    sendMessage: post,
    async startTyping(action = "typing") {
      const chatId = state.chatId ?? "";
      if (!chatId) return;
      try {
        await sendTelegramChatAction({
          action, apiBaseUrl: api?.apiBaseUrl, chatId, credentials, fetch: api?.fetch, messageThreadId: state.messageThreadId ?? undefined,
        });
      } catch (error) {
        // An indicator only: the turn goes on without it.
        console.warn(JSON.stringify({ chatId, code: "AGENT_TELEGRAM_TYPING_FAILED", error: error instanceof Error ? error.message : String(error) }));
      }
    },
  };
}
