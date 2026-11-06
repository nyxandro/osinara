/**
 * The only Telegram calls a private question makes: a reply seen by one person and edits of it (#467).
 *
 * Exports:
 * - `PrivateQuestionTelegram`, `createPrivateQuestionTelegram`: an ephemeral reply to an ephemeral command
 *   and the edit of that reply, as text or as a Rich Message.
 * - `privateQuestionTelegram`: the production calls with the bot's token.
 *
 * Key constructs:
 * - Bot API 10.3: the receiver goes in `ephemeral_message_parameters`, not at the top level (10.2's
 *   `receiver_user_id` there was replaced).
 * - A reply is allowed only within 15 s of the command and is aimed at it by `reply_parameters.ephemeral_message_id`.
 * - An edit that changes nothing (a replay after a restart) is answered "message is not modified": that is
 *   the wanted state, not a failure.
 * - Telegram answers True to an edit even when the person never receives it; nothing here can tell.
 */
import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import type { JsonObject } from "../../runtime/json.js";
import { callTelegramApi, type TelegramApiResponse } from "../../runtime/telegram/api.js";

const NOT_MODIFIED = "message is not modified";

export type EphemeralReplyResult =
  | { readonly kind: "sent"; readonly ephemeralMessageId: number }
  | { readonly kind: "throttled"; readonly retryAfterSeconds: number }
  | { readonly kind: "rejected"; readonly description: string; readonly status: number };

export type EphemeralEditResult =
  | { readonly kind: "edited" }
  | { readonly kind: "rejected"; readonly description: string; readonly status: number };

export type EphemeralContent =
  | { readonly text: string }
  | { readonly markdown: string; readonly replyMarkup?: JsonObject };

export interface PrivateQuestionTelegram {
  reply(input: {
    readonly chatId: string;
    readonly receiverUserId: string;
    readonly replyToEphemeralMessageId: number;
    readonly text: string;
    readonly threadId: number | null;
  }): Promise<EphemeralReplyResult>;
  edit(input: {
    readonly chatId: string;
    readonly content: EphemeralContent;
    readonly ephemeralMessageId: number;
    readonly receiverUserId: string;
  }): Promise<EphemeralEditResult>;
}

function description(response: TelegramApiResponse): string {
  const body = response.body;
  return typeof body === "object" && body !== null && "description" in body && typeof body.description === "string"
    ? body.description
    : `HTTP ${response.status}`;
}

function retryAfter(response: TelegramApiResponse): number | null {
  const body = response.body as { parameters?: { retry_after?: unknown } } | null;
  const value = body?.parameters?.retry_after;
  return response.status === 429 && typeof value === "number" && value >= 0 ? value : null;
}

export function createPrivateQuestionTelegram(
  call: (method: string, body: JsonObject) => Promise<TelegramApiResponse>,
): PrivateQuestionTelegram {
  return {
    async reply(input) {
      const response = await call("sendMessage", {
        chat_id: input.chatId,
        ephemeral_message_parameters: { receiver_user_id: Number(input.receiverUserId) },
        reply_parameters: { ephemeral_message_id: input.replyToEphemeralMessageId },
        text: input.text,
        ...(input.threadId === null ? {} : { message_thread_id: input.threadId }),
      });
      if (response.ok) {
        const result = (response.body as { result?: { ephemeral_message_id?: unknown } } | null)?.result;
        const id = result?.ephemeral_message_id;
        if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return { ephemeralMessageId: id, kind: "sent" };
        return { description: "Telegram returned no ephemeral_message_id", kind: "rejected", status: response.status };
      }
      const wait = retryAfter(response);
      if (wait !== null) return { kind: "throttled", retryAfterSeconds: wait };
      return { description: description(response), kind: "rejected", status: response.status };
    },

    async edit(input) {
      const content: JsonObject = "text" in input.content
        ? { text: input.content.text }
        : {
            rich_message: { markdown: input.content.markdown },
            ...(input.content.replyMarkup === undefined ? {} : { reply_markup: input.content.replyMarkup }),
          };
      const response = await call("editEphemeralMessageText", {
        chat_id: input.chatId,
        ephemeral_message_id: input.ephemeralMessageId,
        receiver_user_id: Number(input.receiverUserId),
        ...content,
      });
      if (response.ok || description(response).includes(NOT_MODIFIED)) return { kind: "edited" };
      return { description: description(response), kind: "rejected", status: response.status };
    },
  };
}

export const privateQuestionTelegram = createPrivateQuestionTelegram((method, body) => callTelegramApi({
  body,
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
  method,
}));
