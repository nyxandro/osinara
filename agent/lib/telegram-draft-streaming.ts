/**
 * Native Telegram draft streaming for model-authored output.
 *
 * Exports:
 * - `streamTelegramMessageDraft`: immediately forwards one cumulative Eve update.
 *
 * Key constructs:
 * - Private-chat-only policy matching Telegram's `sendMessageDraft` contract.
 * - Stable non-zero draft IDs derived from Eve turn and assistant step identifiers.
 * - Safe balanced HTML previews and a request-scoped timeout without retries.
 */
import { createHash } from "node:crypto";

import { callTelegramApi, type TelegramApiResponse } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";
import { formatTelegramMarkdownDraft } from "./telegram-markdown.js";

const TELEGRAM_DRAFT_ID_MODULUS = 2_147_483_647;

interface TelegramDraftEvent {
  readonly messageSoFar: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

interface TelegramDraftTarget {
  readonly chatId: string;
  readonly chatType: "channel" | "group" | "private" | "supergroup" | undefined;
  readonly messageThreadId: number | undefined;
}

type TelegramApiInput = Parameters<typeof callTelegramApi>[0];
type TelegramApiBody = NonNullable<TelegramApiInput["body"]>;

function requireTelegramBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError(
      "AGENT_TELEGRAM_DRAFT_CONFIG_MISSING",
      "Не задан Telegram bot token для потоковой отправки ответа",
    );
  }
  return botToken;
}

function privateChatId(telegram: TelegramDraftTarget): number {
  const chatId = Number(telegram.chatId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new AppError(
      "AGENT_TELEGRAM_DRAFT_CHAT_ID_INVALID",
      "Telegram передал некорректный идентификатор личного чата",
    );
  }
  return chatId;
}

function draftId(event: TelegramDraftEvent): number {
  if (!event.turnId || !Number.isSafeInteger(event.stepIndex) || event.stepIndex < 0) {
    throw new AppError(
      "AGENT_TELEGRAM_DRAFT_EVENT_INVALID",
      "Eve передал неполные данные потокового ответа Telegram",
    );
  }

  // SHA-256 makes collisions between concurrent turns negligible; modulo keeps Bot API's signed ID.
  const digest = createHash("sha256")
    .update(event.turnId)
    .update(":")
    .update(String(event.stepIndex))
    .digest();
  return (digest.readUInt32BE(0) % TELEGRAM_DRAFT_ID_MODULUS) + 1;
}

function telegramDraftFetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(request, { ...init, signal });
}

function isSuccessfulDraftResponse(response: TelegramApiResponse): boolean {
  if (!response.ok || typeof response.body !== "object" || response.body === null) return false;
  return "ok" in response.body && response.body.ok === true &&
    "result" in response.body && response.body.result === true;
}

function addStableErrorCode(error: Error): void {
  // DOMException exposes a getter-only message, so define an own property without wrapping it.
  Object.defineProperty(error, "message", {
    configurable: true,
    value: `AGENT_TELEGRAM_DRAFT_DELIVERY_FAILED: ${error.message}`,
    writable: true,
  });
}

async function requestTelegramDraft(body: TelegramApiBody): Promise<void> {
  let response: TelegramApiResponse;
  try {
    response = await callTelegramApi({
      body,
      botToken: requireTelegramBotToken(),
      fetch: telegramDraftFetch,
      method: "sendMessageDraft",
    });
  } catch (error) {
    // Preserve the transport error while attaching structured, stable diagnostics.
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_DRAFT_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      providerMessage: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof Error) addStableErrorCode(error);
    throw error;
  }

  if (isSuccessfulDraftResponse(response)) return;
  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_DRAFT_DELIVERY_FAILED",
    providerBody: response.body,
    providerStatus: response.status,
  }));
  throw new AppError(
    "AGENT_TELEGRAM_DRAFT_DELIVERY_FAILED",
    "Telegram не принял потоковое обновление ответа. Попробуйте отправить сообщение еще раз",
  );
}

export async function streamTelegramMessageDraft(
  event: TelegramDraftEvent,
  telegram: TelegramDraftTarget,
): Promise<void> {
  // Telegram exposes native drafts only for private chats; groups retain completed delivery.
  if (telegram.chatType !== "private") return;

  const text = formatTelegramMarkdownDraft(event.messageSoFar);
  if (!text) return;

  await requestTelegramDraft({
    chat_id: privateChatId(telegram),
    draft_id: draftId(event),
    ...(telegram.messageThreadId === undefined
      ? {}
      : { message_thread_id: telegram.messageThreadId }),
    parse_mode: "HTML",
    text,
  });
}
