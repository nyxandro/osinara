/**
 * Bounded Telegram Bot API transport for application-owned update proposals.
 *
 * Exports:
 * - `SoftwareUpdateTransportError`: definite or ambiguous Telegram delivery failure.
 * - `createSoftwareUpdateTelegramTransport`: injectable no-retry transport factory.
 * - `softwareUpdateTelegramTransport`: lazy production transport using the required bot token.
 */
import {
  answerTelegramCallbackQuery,
  callTelegramApi,
  editTelegramMessageReplyMarkup,
} from "eve/channels/telegram";
import { z } from "zod";

import { SOFTWARE_UPDATE_HTTP_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import type { SoftwareUpdateTelegramTransport } from "./types.js";

const telegramMessageResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    chat: z.object({
      id: z.union([z.string(), z.number()]),
      type: z.literal("private"),
    }),
    message_id: z.union([z.string(), z.number()]),
  }),
});

export class SoftwareUpdateTransportError extends AppError {
  readonly delivery: "ambiguous" | "failed";

  constructor(
    delivery: "ambiguous" | "failed",
    code: string,
    message: string,
  ) {
    super(code, message);
    this.delivery = delivery;
    this.name = "SoftwareUpdateTransportError";
  }
}

interface SoftwareUpdateTelegramTransportDependencies {
  botToken: string;
  fetch: typeof fetch;
  timeoutMs: number;
}

type TelegramJsonValue =
  | boolean
  | null
  | number
  | string
  | TelegramJsonValue[]
  | { [key: string]: TelegramJsonValue };
type TelegramJsonObject = { [key: string]: TelegramJsonValue };

function toTelegramJson(value: unknown): TelegramJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) return value;
  if (Array.isArray(value)) return value.map(toTelegramJson);
  if (typeof value !== "object") {
    throw new AppError(
      "AGENT_SOFTWARE_UPDATE_MARKUP_INVALID",
      "Не удалось подготовить безопасные кнопки обновления",
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toTelegramJson(item)]),
  );
}

function requirePositiveMessageId(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new SoftwareUpdateTransportError(
      "ambiguous",
      "AGENT_SOFTWARE_UPDATE_TELEGRAM_RESPONSE_INVALID",
      "Telegram не вернул идентификатор сообщения с предложением обновления",
    );
  }
  return value;
}

export function createSoftwareUpdateTelegramTransport(
  dependencies: SoftwareUpdateTelegramTransportDependencies,
): SoftwareUpdateTelegramTransport {
  if (!dependencies.botToken) {
    throw new AppError(
      "AGENT_TELEGRAM_CONFIG_MISSING",
      "Не задан токен Telegram для предложения обновления",
    );
  }
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new AppError(
      "AGENT_SOFTWARE_UPDATE_TIMEOUT_INVALID",
      "Тайм-аут Telegram должен быть положительным целым числом",
    );
  }

  const boundedFetch: typeof fetch = (request, init) => dependencies.fetch(request, {
    ...init,
    signal: AbortSignal.timeout(dependencies.timeoutMs),
  });

  async function requireAccepted(method: string, body: TelegramJsonObject): Promise<void> {
    const response = await callTelegramApi({
      body,
      botToken: dependencies.botToken,
      fetch: boundedFetch,
      method,
    });
    if (!response.ok) {
      throw new SoftwareUpdateTransportError(
        "failed",
        "AGENT_SOFTWARE_UPDATE_TELEGRAM_REJECTED",
        `Telegram отклонил запрос ${method} (HTTP ${response.status})`,
      );
    }
  }

  return {
    async sendPlaceholder(input) {
      const response = await callTelegramApi({
        body: { chat_id: input.chatId, text: input.text },
        botToken: dependencies.botToken,
        fetch: boundedFetch,
        method: "sendMessage",
      });
      if (!response.ok) {
        throw new SoftwareUpdateTransportError(
          "failed",
          "AGENT_SOFTWARE_UPDATE_TELEGRAM_REJECTED",
          `Telegram отклонил отправку предложения обновления (HTTP ${response.status})`,
        );
      }
      const parsed = telegramMessageResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        throw new SoftwareUpdateTransportError(
          "ambiguous",
          "AGENT_SOFTWARE_UPDATE_TELEGRAM_RESPONSE_INVALID",
          "Telegram принял запрос, но не вернул точную привязку сообщения обновления",
        );
      }
      return {
        chatId: String(parsed.data.result.chat.id),
        chatType: parsed.data.result.chat.type,
        messageId: requirePositiveMessageId(String(parsed.data.result.message_id)),
      };
    },

    editProposal(input) {
      return requireAccepted("editMessageText", {
        chat_id: input.chatId,
        message_id: Number(input.messageId),
        reply_markup: toTelegramJson(input.replyMarkup),
        text: input.text,
      });
    },

    async removeKeyboard(input) {
      const response = await editTelegramMessageReplyMarkup({
        chatId: input.chatId,
        credentials: { botToken: dependencies.botToken },
        fetch: boundedFetch,
        messageId: input.messageId,
        replyMarkup: { inline_keyboard: [] },
      });
      if (!response.ok) {
        throw new SoftwareUpdateTransportError(
          "failed",
          "AGENT_SOFTWARE_UPDATE_KEYBOARD_REMOVE_FAILED",
          `Telegram не убрал кнопки предложения обновления (HTTP ${response.status})`,
        );
      }
    },

    async answerCallback(input) {
      const response = await answerTelegramCallbackQuery({
        callbackQueryId: input.callbackQueryId,
        credentials: { botToken: dependencies.botToken },
        fetch: boundedFetch,
        showAlert: input.showAlert,
        text: input.text,
      });
      if (!response.ok) {
        throw new SoftwareUpdateTransportError(
          "failed",
          "AGENT_SOFTWARE_UPDATE_CALLBACK_ANSWER_FAILED",
          `Telegram не подтвердил обработку кнопки обновления (HTTP ${response.status})`,
        );
      }
    },
  };
}

function productionTransport(): SoftwareUpdateTelegramTransport {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError(
      "AGENT_TELEGRAM_CONFIG_MISSING",
      "Не задан токен Telegram для предложения обновления",
    );
  }
  return createSoftwareUpdateTelegramTransport({
    botToken,
    fetch,
    timeoutMs: SOFTWARE_UPDATE_HTTP_TIMEOUT_MS,
  });
}

// Configuration remains lazy so Eve discovery and build do not require runtime secrets.
export const softwareUpdateTelegramTransport: SoftwareUpdateTelegramTransport = {
  answerCallback: (input) => productionTransport().answerCallback(input),
  editProposal: (input) => productionTransport().editProposal(input),
  removeKeyboard: (input) => productionTransport().removeKeyboard(input),
  sendPlaceholder: (input) => productionTransport().sendPlaceholder(input),
};
