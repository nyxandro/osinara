/**
 * Telegram delivery that preserves Eve's stable continuation hook.
 *
 * Exports:
 * - `StableTelegramMessageReceipt`: provider-confirmed Telegram message identity.
 * - `postTelegramMessageWithReceiptWithoutContinuationChange`: sends one message and returns its
 *   provider-confirmed message id and chat type.
 * - `postTelegramMessageWithoutContinuationChange`: sends one short service message via the raw
 *   Bot API handle and returns its verified message ID without mutating channel anchor state.
 */
import type { TelegramChatType } from "../runtime/telegram/inbound.js";
import type { TelegramEventContext } from "../runtime/telegram/channel-types.js";

import { AppError } from "./app-error.js";

type TelegramJsonValue =
  | boolean
  | null
  | number
  | string
  | { readonly [key: string]: TelegramJsonValue }
  | readonly TelegramJsonValue[];

interface StableTelegramMessage {
  readonly reply_markup?: Readonly<Record<string, unknown>>;
  readonly reply_parameters?: Readonly<Record<string, unknown>>;
  readonly text: string;
}

export interface StableTelegramMessageReceipt {
  readonly chatType: TelegramChatType;
  readonly messageId: string;
}

interface StableTelegramProviderResult {
  readonly chat?: { readonly type?: unknown };
  readonly message_id?: unknown;
}

const TELEGRAM_CHAT_TYPES = new Set<TelegramChatType>([
  "channel",
  "group",
  "private",
  "supergroup",
]);

function telegramJson(value: unknown): TelegramJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) return value;
  if (Array.isArray(value)) return value.map(telegramJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, telegramJson(item)]));
  }
  throw new AppError(
    "AGENT_TELEGRAM_DELIVERY_PAYLOAD_INVALID",
    "Не удалось подготовить служебное сообщение для Telegram",
  );
}

async function requestStableTelegramMessage(
  channel: TelegramEventContext,
  message: string | StableTelegramMessage,
): Promise<StableTelegramProviderResult> {
  const chatId = channel.state.chatId;
  if (!chatId) {
    throw new AppError(
      "AGENT_TELEGRAM_DELIVERY_CONTEXT_INVALID",
      "Не удалось определить Telegram-чат для отправки сообщения",
    );
  }

  // `telegram.post` re-keys Eve as a side effect. Raw `sendMessage` deliberately bypasses that
  // adapter mutation while retaining Eve's authenticated Telegram API transport.
  const payload = typeof message === "string"
    ? { text: message }
    : {
        ...(message.reply_markup === undefined
          ? {}
          : { reply_markup: telegramJson(message.reply_markup) }),
        ...(message.reply_parameters === undefined
          ? {}
          : { reply_parameters: telegramJson(message.reply_parameters) }),
        text: message.text,
      };
  const response = await channel.telegram.request("sendMessage", {
    chat_id: chatId,
    ...(channel.state.messageThreadId === null
      ? {}
      : { message_thread_id: channel.state.messageThreadId }),
    ...payload,
  });
  const body = response.body as {
    ok?: unknown;
    result?: StableTelegramProviderResult;
  };
  if (!response.ok || body.ok !== true) {
    throw new AppError(
      "AGENT_TELEGRAM_MESSAGE_DELIVERY_FAILED",
      "Telegram не принял обычное сообщение. Попробуйте повторить запрос",
    );
  }
  return body.result ?? {};
}

function requireStableTelegramMessageId(result: StableTelegramProviderResult): string {
  const messageId = result.message_id;
  if (Number.isSafeInteger(messageId) && Number(messageId) > 0) return String(messageId);
  throw new AppError(
    "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS",
    "Telegram принял запрос, но не подтвердил идентификатор обычного сообщения",
  );
}

export async function postTelegramMessageWithReceiptWithoutContinuationChange(
  channel: TelegramEventContext,
  message: string | StableTelegramMessage,
): Promise<StableTelegramMessageReceipt> {
  const result = await requestStableTelegramMessage(channel, message);
  const messageId = requireStableTelegramMessageId(result);
  const chatType = result.chat?.type;
  if (
    typeof chatType === "string" &&
    TELEGRAM_CHAT_TYPES.has(chatType as TelegramChatType)
  ) {
    return {
      chatType: chatType as TelegramChatType,
      messageId,
    };
  }
  throw new AppError(
    "AGENT_TELEGRAM_MESSAGE_DELIVERY_AMBIGUOUS",
    "Telegram принял запрос, но не подтвердил тип чата доставленного сообщения",
  );
}

export async function postTelegramMessageWithoutContinuationChange(
  channel: TelegramEventContext,
  message: string | StableTelegramMessage,
): Promise<string> {
  return requireStableTelegramMessageId(await requestStableTelegramMessage(channel, message));
}
