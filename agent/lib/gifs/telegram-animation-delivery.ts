/**
 * Delivery of a GIF reply through Telegram `sendAnimation`.
 *
 * Export:
 * - `sendTelegramAnimation`: Telegram downloads the KLIPY MP4 itself and shows it as an animation.
 *
 * Key constructs:
 * - The media URL goes to Telegram exactly as KLIPY returned it: the backend neither downloads nor
 *   stores the animation.
 * - A refusal from Telegram is definitive. A lost connection or an answer without a message id
 *   leaves open whether the chat already shows the animation, so it is reported as ambiguous and
 *   never repeated automatically.
 */
import { callTelegramApi, resolveTelegramBotToken } from "../../runtime/telegram/api.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { telegramCaptionFits } from "../attachments/telegram-workspace-file-delivery.js";
import { renderTelegramMarkdownHtml } from "../telegram-markdown.js";

function ambiguousDelivery(): AppError {
  return new AppError(
    "AGENT_GIF_DELIVERY_AMBIGUOUS",
    "Не удалось подтвердить отправку гифки. Проверьте чат перед повторной просьбой",
  );
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

export async function sendTelegramAnimation(
  input: {
    caption?: string;
    chatId: string;
    height: number;
    messageThreadId?: number;
    replyToMessageId?: number;
    url: string;
    width: number;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ telegramMessageId: string }> {
  if (input.caption !== undefined && !telegramCaptionFits(input.caption)) {
    throw new AppError(
      "AGENT_TELEGRAM_CAPTION_TOO_LONG",
      "Подпись превышает лимит Telegram 1024 символа. Сократите подпись или отправьте текст отдельно",
    );
  }
  // A missing token is a configuration failure, not a send that may have happened.
  const botToken = await resolveTelegramBotToken(process.env.TELEGRAM_BOT_TOKEN);
  let response: Awaited<ReturnType<typeof callTelegramApi>>;
  try {
    response = await callTelegramApi({
      body: {
        animation: input.url,
        chat_id: input.chatId,
        height: input.height,
        width: input.width,
        ...(input.messageThreadId === undefined ? {} : { message_thread_id: input.messageThreadId }),
        ...(input.caption === undefined
          ? {}
          : { caption: renderTelegramMarkdownHtml(input.caption), parse_mode: "HTML" }),
        ...(input.replyToMessageId === undefined
          ? {}
          : { reply_parameters: { allow_sending_without_reply: true, message_id: input.replyToMessageId } }),
      },
      botToken,
      fetch: (request, init) =>
        fetchImplementation(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS) }),
      method: "sendAnimation",
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GIF_DELIVERY_AMBIGUOUS",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw ambiguousDelivery();
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      code: "AGENT_GIF_DELIVERY_FAILED",
      description: telegramDescription(response.body),
      providerStatus: response.status,
    }));
    throw new AppError("AGENT_GIF_DELIVERY_FAILED", "Telegram не принял гифку");
  }
  const messageId = sentMessageId(response.body);
  if (messageId === null) {
    console.error(JSON.stringify({ code: "AGENT_GIF_DELIVERY_AMBIGUOUS", providerStatus: response.status }));
    throw ambiguousDelivery();
  }
  return { telegramMessageId: String(messageId) };
}
