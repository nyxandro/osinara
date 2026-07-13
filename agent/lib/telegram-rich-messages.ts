/**
 * Native Telegram Rich Message transport for model-authored output.
 *
 * Exports:
 * - `startTelegramRichThinkingDraft`: displays Telegram's native ephemeral thinking block.
 * - `streamTelegramRichMessageDraft`: updates the same chat-scoped draft with model output.
 * - `postTelegramRichMessage`: persists completed rich output and records group anchors.
 *
 * Key constructs:
 * - One stable non-zero draft ID per private chat/topic across turns and model steps.
 * - Telegram Bot API 10.1 `sendRichMessageDraft` and `sendRichMessage` validation.
 * - Final-delivery ambiguity diagnostics without automatic retries.
 */
import { createHash } from "node:crypto";

import {
  callTelegramApi,
  type TelegramApiResponse,
  type TelegramChannelState,
  type TelegramChatType,
  type TelegramHandle,
} from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../config.js";
import { AppError } from "./app-error.js";
import {
  formatTelegramRichMessageDraft,
  formatTelegramRichMessages,
} from "./telegram-rich-markdown.js";

const TELEGRAM_DRAFT_ID_MODULUS = 2_147_483_647;
const TELEGRAM_THINKING_CUSTOM_EMOJI_ID = "5535034915403333642";
const TELEGRAM_THINKING_HTML =
  `<tg-thinking><tg-emoji emoji-id="${TELEGRAM_THINKING_CUSTOM_EMOJI_ID}"></tg-emoji> Думаю…</tg-thinking>`;
const TELEGRAM_CHAT_TYPES = new Set<TelegramChatType>([
  "channel",
  "group",
  "private",
  "supergroup",
]);

interface TelegramTurnEvent {
  readonly turnId: string;
}

interface TelegramDraftEvent extends TelegramTurnEvent {
  readonly messageSoFar: string;
  readonly stepIndex: number;
}

type TelegramRichTarget = Pick<
  TelegramHandle,
  "chatId" | "chatType" | "messageThreadId"
>;

type TelegramRichAnchorState = Pick<TelegramChannelState, "chatType" | "conversationId">;
type TelegramApiBody = NonNullable<Parameters<typeof callTelegramApi>[0]["body"]>;

interface SentTelegramMessage {
  readonly chatType: TelegramChatType;
  readonly messageId: string;
}

function draftId(target: TelegramRichTarget): number {
  const thread = target.messageThreadId === undefined ? "" : String(target.messageThreadId);
  const digest = createHash("sha256")
    .update(target.chatId)
    .update(":")
    .update(thread)
    .digest();
  return (digest.readUInt32BE(0) % TELEGRAM_DRAFT_ID_MODULUS) + 1;
}

function requireTelegramBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new AppError(
      "AGENT_TELEGRAM_RICH_CONFIG_MISSING",
      "Не задан Telegram bot token для отправки форматированного ответа",
    );
  }
  return botToken;
}

function numericChatId(target: TelegramRichTarget, privateOnly: boolean): number | string {
  const numeric = Number(target.chatId);
  if (Number.isSafeInteger(numeric) && numeric !== 0 && (!privateOnly || numeric > 0)) {
    return numeric;
  }
  if (!privateOnly && /^@[A-Za-z][A-Za-z0-9_]{3,}$/u.test(target.chatId)) {
    return target.chatId;
  }
  throw new AppError(
    "AGENT_TELEGRAM_RICH_CHAT_ID_INVALID",
    "Telegram передал некорректный идентификатор чата",
  );
}

function telegramRichFetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(request, { ...init, signal });
}

function addStableErrorCode(error: Error, code: string): void {
  // DOMException exposes a getter-only message, so attach diagnostics without replacing the cause.
  Object.defineProperty(error, "message", {
    configurable: true,
    value: `${code}: ${error.message}`,
    writable: true,
  });
}

async function requestTelegramRichApi(
  method: "sendRichMessage" | "sendRichMessageDraft",
  body: TelegramApiBody,
): Promise<TelegramApiResponse> {
  const transportCode = method === "sendRichMessage"
    ? "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS"
    : "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED";
  let response: TelegramApiResponse;
  try {
    response = await callTelegramApi({
      body,
      botToken: requireTelegramBotToken(),
      fetch: telegramRichFetch,
      method,
    });
  } catch (error) {
    // A final network failure is ambiguous because Telegram may have accepted the message.
    console.error(JSON.stringify({
      code: transportCode,
      errorName: error instanceof Error ? error.name : "UnknownError",
      method,
    }));
    if (error instanceof Error) addStableErrorCode(error, transportCode);
    throw error;
  }

  if (response.ok && typeof response.body === "object" && response.body !== null &&
    "ok" in response.body && response.body.ok === true) {
    return response;
  }
  const rejectionCode = method === "sendRichMessage"
    ? "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_FAILED"
    : "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED";
  console.error(JSON.stringify({
    code: rejectionCode,
    method,
    providerStatus: response.status,
  }));
  throw new AppError(
    rejectionCode,
    method === "sendRichMessage"
      ? "Telegram не принял форматированный ответ. Попробуйте отправить запрос ещё раз"
      : "Telegram не принял потоковое обновление ответа. Попробуйте отправить запрос ещё раз",
  );
}

function requireDraftSuccess(response: TelegramApiResponse): void {
  const body = response.body as { result?: unknown };
  if (body.result === true) return;
  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED",
    method: "sendRichMessageDraft",
    providerStatus: response.status,
  }));
  throw new AppError(
    "AGENT_TELEGRAM_RICH_DRAFT_DELIVERY_FAILED",
    "Telegram вернул некорректное подтверждение потокового ответа",
  );
}

function requireSentMessage(response: TelegramApiResponse): SentTelegramMessage {
  const body = response.body as {
    result?: {
      chat?: { type?: unknown };
      message_id?: unknown;
    };
  };
  const messageId = body.result?.message_id;
  const chatType = body.result?.chat?.type;
  if (Number.isSafeInteger(messageId) && Number(messageId) > 0 &&
    typeof chatType === "string" && TELEGRAM_CHAT_TYPES.has(chatType as TelegramChatType)) {
    return { chatType: chatType as TelegramChatType, messageId: String(messageId) };
  }
  console.error(JSON.stringify({
    code: "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS",
    method: "sendRichMessage",
    providerStatus: response.status,
  }));
  throw new AppError(
    "AGENT_TELEGRAM_RICH_MESSAGE_DELIVERY_AMBIGUOUS",
    "Telegram принял запрос, но не подтвердил идентификатор отправленного сообщения",
  );
}

function richBody(
  target: TelegramRichTarget,
  richMessage: Readonly<{ html: string } | { markdown: string }>,
  privateOnly: boolean,
): TelegramApiBody {
  return {
    chat_id: numericChatId(target, privateOnly),
    ...(target.messageThreadId === undefined
      ? {}
      : { message_thread_id: target.messageThreadId }),
    rich_message: richMessage,
  };
}

export async function startTelegramRichThinkingDraft(
  target: TelegramRichTarget,
): Promise<void> {
  if (target.chatType !== "private") return;
  const response = await requestTelegramRichApi("sendRichMessageDraft", {
    ...richBody(target, { html: TELEGRAM_THINKING_HTML }, true),
    draft_id: draftId(target),
  });
  requireDraftSuccess(response);
}

export async function streamTelegramRichMessageDraft(
  event: TelegramDraftEvent,
  target: TelegramRichTarget,
): Promise<void> {
  if (target.chatType !== "private") return;
  const markdown = formatTelegramRichMessageDraft(event.messageSoFar);
  if (!markdown) return;
  const response = await requestTelegramRichApi("sendRichMessageDraft", {
    ...richBody(target, { markdown }, true),
    draft_id: draftId(target),
  });
  requireDraftSuccess(response);
}

export async function postTelegramRichMessage(
  markdown: string,
  target: TelegramRichTarget,
  state?: TelegramRichAnchorState,
): Promise<void> {
  const chunks = formatTelegramRichMessages(markdown);
  for (const chunk of chunks) {
    const response = await requestTelegramRichApi(
      "sendRichMessage",
      richBody(target, { markdown: chunk }, false),
    );
    const sent = requireSentMessage(response);

    // Eve normally anchors groups inside `telegram.post`; raw rich delivery mirrors that contract.
    if (state) {
      if (state.chatType === null) state.chatType = sent.chatType;
      if (sent.chatType === "group" || sent.chatType === "supergroup") {
        state.conversationId = sent.messageId;
      }
    }
  }
}
