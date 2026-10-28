/**
 * Telegram calls of reply buttons outside a turn: settling a message and answering a press.
 *
 * Exports:
 * - `ReplyButtonTelegram`: the two calls, injectable for tests.
 * - `replyButtonTelegram`: the production transport over the bot token.
 *
 * Key constructs:
 * - Settling rewrites the rich message as the exact text the buttons went out with and a caption
 *   in their place: the buttons are part of the message, so the edit that adds the caption is the
 *   edit that removes them. A message with files names each of them again by its Telegram file:
 *   Telegram refuses an edit of such a message that does not.
 * - Every refusal is logged with Telegram's own description, so a failure can be diagnosed later.
 */
import {
  answerTelegramCallbackQuery,
  callTelegramApi,
  type TelegramApiResponse,
} from "../../runtime/telegram/api.js";

import type { JsonObject } from "../../runtime/json.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import type { ReplyButtonSet } from "./reply-button-repository.js";

export interface ReplyButtonTelegram {
  answerPress(input: { callbackQueryId: string; showAlert?: boolean; text?: string }): Promise<void>;
  /** Removes the buttons of a delivered set and writes the caption in their place. */
  settle(set: Pick<ReplyButtonSet, "messageMedia" | "messageText" | "telegramChatId" | "telegramMessageId">, caption: string): Promise<void>;
}

function requireBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError("AGENT_TELEGRAM_CONFIG_MISSING", "Не задан токен Telegram для кнопок ответа");
  }
  return botToken;
}

const timedFetch: typeof fetch = (request, init) =>
  fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) });

// Telegram refuses an edit that changes nothing: the message already shows what the edit asked for.
const NOT_MODIFIED = "message is not modified";

function alreadySettled(response: TelegramApiResponse): boolean {
  const body = response.body;
  return typeof body === "object" && body !== null && "description" in body &&
    typeof body.description === "string" && body.description.includes(NOT_MODIFIED);
}

/** Telegram's own explanation of a refusal, when it gave one, with the HTTP status. */
function failureDetails(response: TelegramApiResponse): Record<string, number | string> {
  const body = response.body;
  const description = typeof body === "object" && body !== null && "description" in body &&
    typeof body.description === "string" ? body.description : null;
  return { status: response.status, ...(description === null ? {} : { description }) };
}

async function request(method: string, body: JsonObject): Promise<TelegramApiResponse> {
  return await callTelegramApi({ body, botToken: requireBotToken(), fetch: timedFetch, method });
}

export const replyButtonTelegram: ReplyButtonTelegram = {
  async answerPress(input) {
    const response = await answerTelegramCallbackQuery({
      callbackQueryId: input.callbackQueryId,
      credentials: { botToken: requireBotToken() },
      fetch: timedFetch,
      ...(input.showAlert === undefined ? {} : { showAlert: input.showAlert }),
      ...(input.text === undefined ? {} : { text: input.text }),
    });
    if (!response.ok) {
      throw new AppError("AGENT_REPLY_BUTTON_ANSWER_FAILED", "Telegram не принял ответ на нажатие кнопки", {
        details: failureDetails(response),
      });
    }
  },

  async settle(set, caption) {
    if (set.telegramMessageId === null || set.messageText === null) {
      throw new AppError("AGENT_REPLY_BUTTONS_MESSAGE_MISSING", "Неизвестно сообщение, в котором стоят кнопки");
    }
    const edited = await request("editMessageText", {
      chat_id: set.telegramChatId,
      message_id: Number(set.telegramMessageId),
      rich_message: {
        markdown: `${set.messageText}\n\n_${caption}_`,
        ...(set.messageMedia.length === 0
          ? {}
          : { media: set.messageMedia.map((file) => ({ id: file.id, media: { media: file.fileId, type: file.kind } })) }),
      },
    });
    if (edited.ok || alreadySettled(edited)) return;
    throw new AppError("AGENT_REPLY_BUTTONS_SETTLE_FAILED", "Telegram не убрал кнопки из сообщения", {
      details: { ...failureDetails(edited), telegramChatId: set.telegramChatId, telegramMessageId: set.telegramMessageId },
    });
  },
};
