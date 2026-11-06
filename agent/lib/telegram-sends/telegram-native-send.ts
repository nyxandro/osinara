/**
 * One native Telegram message a tool sends on its own: a place, a point on the map, a poll, a
 * contact card or a widget.
 *
 * Exports:
 * - `TelegramNativeSendTarget`: the verified chat, its topic and the group message it answers.
 * - `TelegramNativeSendCodes`: the stable codes and texts of a refused and an unconfirmed send.
 * - `TelegramNativeSendRefusal`: a refusal the calling tool recognizes by Telegram's description.
 * - `sendTelegramNativeMessage`: calls one Bot API send method and returns the sent message's id.
 * - `groupReplyToMessageId`: in a group, the message that addressed the agent, which a sent
 *   message answers like a text answer does.
 *
 * Key construct:
 * - A refusal a tool lists in `refusals` keeps its own code, so the tool can tell the model what to fix
 *   (a widget over Telegram's size); any other refusal is the tool's general failure.
 * - A refusal from Telegram is definitive. A lost connection, a server error or an answer without a
 *   message id leaves open whether the chat already shows the message, so it is reported as
 *   ambiguous and never repeated automatically.
 */
import type { ToolContext } from "../../runtime/tool.js";
import type { JsonObject } from "../../runtime/json.js";
import { callTelegramApi, resolveTelegramBotToken } from "../../runtime/telegram/api.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { telegramTurnReplyParameters } from "../telegram-reply.js";

export interface TelegramNativeSendTarget {
  chatId: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}

export interface TelegramNativeSendRefusal {
  readonly code: string;
  readonly message: string;
  /** A fragment of Telegram's description, such as `INPUT_MEDIA_WIDGET_TOO_LARGE`. */
  readonly telegramError: string;
}

export interface TelegramNativeSendCodes {
  ambiguous: string;
  ambiguousMessage: string;
  failed: string;
  failedMessage: string;
}

function telegramDescription(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const description = (body as { description?: unknown }).description;
  return typeof description === "string" ? description : undefined;
}

function sentMessageId(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const { ok, result } = body as { ok?: unknown; result?: { message_id?: unknown } };
  const messageId = result?.message_id;
  return ok === true && typeof messageId === "number" && Number.isSafeInteger(messageId) ? messageId : null;
}

export async function sendTelegramNativeMessage(
  input: {
    /** The Bot API address, when the method lives elsewhere (the widget methods on the beta address). */
    apiBaseUrl?: string;
    body: JsonObject;
    codes: TelegramNativeSendCodes;
    method: "sendContact" | "sendLocation" | "sendPoll" | "sendVenue" | "sendWidget";
    refusals?: readonly TelegramNativeSendRefusal[];
    target: TelegramNativeSendTarget;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ telegramMessageId: string }> {
  const { codes, target } = input;
  // A missing token is a configuration failure, not a send that may have happened.
  const botToken = await resolveTelegramBotToken(process.env.TELEGRAM_BOT_TOKEN);
  let response: Awaited<ReturnType<typeof callTelegramApi>>;
  try {
    response = await callTelegramApi({
      ...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
      body: {
        ...input.body,
        chat_id: target.chatId,
        ...(target.messageThreadId === undefined ? {} : { message_thread_id: target.messageThreadId }),
        ...(target.replyToMessageId === undefined
          ? {}
          : { reply_parameters: { allow_sending_without_reply: true, message_id: target.replyToMessageId } }),
      },
      botToken,
      fetch: (request, init) =>
        fetchImplementation(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
      method: input.method,
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: codes.ambiguous,
      errorName: error instanceof Error ? error.name : "UnknownError",
      method: input.method,
    }));
    throw new AppError(codes.ambiguous, codes.ambiguousMessage);
  }
  // A 5xx comes from Telegram's front and says nothing about whether the message was posted.
  if (!response.ok && response.status >= 500) {
    console.error(JSON.stringify({ code: codes.ambiguous, method: input.method, providerStatus: response.status }));
    throw new AppError(codes.ambiguous, codes.ambiguousMessage);
  }
  if (!response.ok) {
    const description = telegramDescription(response.body);
    const refusal = input.refusals?.find((known) => description?.includes(known.telegramError) === true);
    console.error(JSON.stringify({
      code: refusal?.code ?? codes.failed,
      description,
      method: input.method,
      providerStatus: response.status,
    }));
    throw new AppError(refusal?.code ?? codes.failed, refusal?.message ?? codes.failedMessage);
  }
  const messageId = sentMessageId(response.body);
  if (messageId === null) {
    console.error(JSON.stringify({ code: codes.ambiguous, method: input.method, providerStatus: response.status }));
    throw new AppError(codes.ambiguous, codes.ambiguousMessage);
  }
  return { telegramMessageId: String(messageId) };
}

export function groupReplyToMessageId(ctx: ToolContext, chatId: string): number | undefined {
  const chatType = ctx.session.auth.current?.attributes.telegramChatType;
  if (chatType !== "group" && chatType !== "supergroup") return undefined;
  return telegramTurnReplyParameters({ chatId, chatType }, ctx)?.message_id;
}
