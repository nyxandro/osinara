/**
 * Telegram calls of reply buttons outside a turn: settling a message and answering a press.
 *
 * Exports:
 * - `ReplyButtonTelegram`: the two calls, injectable for tests.
 * - `replyButtonTelegram`: the production transport over the bot token.
 *
 * Key constructs:
 * - Settling replaces the keyboard with a caption under the exact text the buttons went out with,
 *   in the same format. When Telegram refuses the text edit, the keyboard is still removed: a
 *   choice that is already recorded must not keep offering buttons.
 * - Every refusal is logged with Telegram's own description, so a failure can be diagnosed later.
 */
import {
  answerTelegramCallbackQuery,
  callTelegramApi,
  TELEGRAM_MESSAGE_TEXT_MAX_LENGTH,
  type TelegramApiResponse,
} from "../../runtime/telegram/api.js";

import type { JsonObject } from "../../runtime/json.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import type { ReplyButtonSet } from "./reply-button-repository.js";

const EMPTY_KEYBOARD = { inline_keyboard: [] };

export interface ReplyButtonTelegram {
  answerPress(input: { callbackQueryId: string; showAlert?: boolean; text?: string }): Promise<void>;
  /** Removes the buttons of a delivered set and writes the caption under its text. */
  settle(
    set: Pick<ReplyButtonSet, "messageEntities" | "messageFormat" | "messageText" | "telegramChatId" | "telegramMessageId">,
    caption: string,
  ): Promise<void>;
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

function settledBody(set: Parameters<ReplyButtonTelegram["settle"]>[0], caption: string): JsonObject | null {
  if (set.messageText === null) return null;
  if (set.messageFormat === "rich") {
    return { rich_message: { markdown: `${set.messageText}\n\n_${caption}_` } };
  }
  const text = `${set.messageText}\n\n${caption}`;
  if (text.length > TELEGRAM_MESSAGE_TEXT_MAX_LENGTH) return null;
  // The caption is appended after the original text, so the original entity offsets still hold.
  return set.messageEntities === null ? { text } : { entities: set.messageEntities, text };
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
    if (set.telegramMessageId === null) {
      throw new AppError("AGENT_REPLY_BUTTONS_MESSAGE_MISSING", "Неизвестно сообщение, под которым стоят кнопки");
    }
    const target = { chat_id: set.telegramChatId, message_id: Number(set.telegramMessageId) };
    const body = settledBody(set, caption);
    if (body !== null) {
      const edited = await request("editMessageText", { ...target, ...body, reply_markup: EMPTY_KEYBOARD });
      if (edited.ok || alreadySettled(edited)) return;
      console.error(JSON.stringify({
        code: "AGENT_REPLY_BUTTONS_CAPTION_FAILED",
        ...failureDetails(edited),
        telegramChatId: set.telegramChatId,
        telegramMessageId: set.telegramMessageId,
      }));
    }
    const cleared = await request("editMessageReplyMarkup", { ...target, reply_markup: EMPTY_KEYBOARD });
    if (!cleared.ok && !alreadySettled(cleared)) {
      throw new AppError("AGENT_REPLY_BUTTONS_CLEAR_FAILED", "Telegram не убрал кнопки под сообщением", {
        details: failureDetails(cleared),
      });
    }
  },
};
