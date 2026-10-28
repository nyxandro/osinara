/**
 * Trusted proactive Telegram reminder delivery.
 *
 * Export:
 * - `deliverTelegramReminder`: sends deterministic text and returns its durable delivery receipt.
 *
 * Key construct:
 * - The reminder is laid out like an answer of the chat (`reminder-presentation.ts`): an ordinary
 *   message with the header bold through an entity, or a rich message with its markup, its files
 *   and its buttons. The buttons are staged with the text of that message before the send and
 *   activated after it, keeping the files it showed for the caption's later edit.
 * - When Telegram refuses the rich message, nothing was delivered, so the reminder goes once more as
 *   an ordinary message with the text as written, a line in place of each file, and its buttons are
 *   discarded. A failure whose outcome is unknown is never sent again.
 * - The receipt keeps the text as stored, files as their paths, whatever form the message took.
 */
import { callTelegramApi } from "../../runtime/telegram/api.js";
import type { JsonObject } from "../../runtime/json.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS, TELEGRAM_RICH_MEDIA_UPLOAD_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import type { ProactiveDeliveryReceipt } from "../proactive-deliveries/proactive-delivery-repository.js";
import { reminderReplyButtons } from "../reply-buttons/reply-button-delivery.js";
import { sentRichMediaOf, telegramRichMessageRequest, type SentRichMedia } from "../telegram-rich-messages.js";
import type { ClaimedReminder } from "./reminder-dispatch-repository.js";
import { prepareReminderFiles } from "./reminder-files.js";
import {
  presentReminder,
  REMINDER_HEADER,
  refusedReminder,
  reminderBody,
  type ReminderMessage,
} from "./reminder-presentation.js";

function requireBotToken(): string {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "AGENT_TELEGRAM_CONFIG_MISSING: Не задан токен Telegram для доставки напоминаний",
    );
  }
  return botToken;
}

function messageThreadId(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      "AGENT_REMINDER_THREAD_INVALID: Сохранён некорректный идентификатор темы Telegram",
    );
  }
  return parsed;
}

const TELEGRAM_BAD_REQUEST_STATUS = 400;
const TELEGRAM_DESCRIPTION_MAX_LENGTH = 200;

function formatScheduledTime(job: ClaimedReminder): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: job.timezone,
  }).format(new Date(job.dueAt));
}

function sentMessageId(body: unknown): string {
  if (typeof body !== "object" || body === null || !("result" in body)) return "";
  const result = body.result;
  if (typeof result !== "object" || result === null || !("message_id" in result)) return "";
  return typeof result.message_id === "number" ? String(result.message_id) : "";
}

/**
 * The reminder is delivered either way: a failed activation leaves its buttons pressable but not
 * removed by a later message, and must not turn a delivered reminder into a failed one.
 */
async function activateReminderButtons(
  buttons: { activate(messageId: string, media: readonly SentRichMedia[]): Promise<void> },
  messageId: string,
  media: readonly SentRichMedia[],
  reminderId: string,
): Promise<void> {
  try {
    await buttons.activate(messageId, media);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_REMINDER_BUTTONS_ACTIVATION_FAILED",
      error: error instanceof Error ? error.message : String(error),
      reminderId,
    }));
  }
}

/** The markdown a rich message carries: with its buttons when they go, else as presented. */
function reminderRequest(
  job: ClaimedReminder,
  message: ReminderMessage,
  richMarkdown: string | null,
): { readonly body?: JsonObject; readonly form?: FormData; readonly method: string } {
  const threadId = messageThreadId(job.messageThreadId);
  const thread: JsonObject = threadId === undefined ? {} : { message_thread_id: threadId };
  if (message.format === "rich") {
    const request = telegramRichMessageRequest(
      { chat_id: job.telegramChatId, ...thread },
      richMarkdown ?? message.markdown,
      message.media,
    );
    return { ...request, method: "sendRichMessage" };
  }
  // Telegram counts entity offsets in UTF-16 code units, which is what String length is.
  const entities = [{ length: REMINDER_HEADER.length, offset: 0, type: "bold" }];
  return { body: { chat_id: job.telegramChatId, entities, ...thread, text: message.text }, method: "sendMessage" };
}

/** The staged set stays staged if this fails: nobody can tap buttons that were never sent. */
async function discardReminderButtons(buttons: { discard(): Promise<void> }, reminderId: string): Promise<void> {
  try {
    await buttons.discard();
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_REMINDER_BUTTONS_DISCARD_FAILED",
      error: error instanceof Error ? error.message : String(error),
      reminderId,
    }));
  }
}

/** The start of Telegram's own reason for a refusal: an error text that may quote a tag. */
function telegramDescription(body: unknown): { description?: string } {
  return typeof body === "object" && body !== null && "description" in body && typeof body.description === "string"
    ? { description: body.description.slice(0, TELEGRAM_DESCRIPTION_MAX_LENGTH) }
    : {};
}

export async function deliverTelegramReminder(job: ClaimedReminder): Promise<ProactiveDeliveryReceipt> {
  const delayedNotice = job.delayed
    ? `Доставлено с задержкой. Изначальное время: ${formatScheduledTime(job)} (${job.timezone}).`
    : null;
  const text = [REMINDER_HEADER, job.content, delayedNotice].filter(Boolean).join("\n\n");
  const prepared = await prepareReminderFiles(job, reminderBody(job.content, delayedNotice));
  // Buttons need a rich message and are staged with its text, so it is laid out for them first.
  const buttoned = job.buttons === null ? null : presentReminder(prepared, { replyButtons: true });
  const buttons = buttoned?.format === "rich"
    ? await reminderReplyButtons({
      addresseeTelegramUserId: job.addresseeTelegramUserId,
      buttons: job.buttons,
      messageText: buttoned.markdown,
      reminderId: job.id,
      scope: job.scope,
      telegramChatId: job.telegramChatId,
      telegramChatType: job.telegramChatType,
    })
    : null;
  const message = buttons === null ? presentReminder(prepared, { replyButtons: false }) : buttoned!;
  let providerStatus: number | undefined;
  // Each send has its own time: a second send after a refusal must not inherit what is left.
  const send = async (outgoing: ReminderMessage, richMarkdown: string | null) => {
    const uploads = outgoing.format === "rich" && outgoing.media.length > 0;
    const signal = AbortSignal.timeout(uploads ? TELEGRAM_RICH_MEDIA_UPLOAD_TIMEOUT_MS : TELEGRAM_API_REQUEST_TIMEOUT_MS);
    return await callTelegramApi({
      ...reminderRequest(job, outgoing, richMarkdown),
      botToken: requireBotToken(),
      fetch: (request, init) => fetch(request, { ...init, signal }),
    });
  };
  // Telegram has no idempotency key; the durable marker is written before this boundary call.
  try {
    let response = await send(message, buttons?.markdown ?? null);
    let sent = message;
    if (!response.ok && message.format === "rich" && response.status === TELEGRAM_BAD_REQUEST_STATUS) {
      // A refusal delivered nothing, so the reminder itself still goes, as written.
      console.error(JSON.stringify({
        code: "AGENT_REMINDER_RICH_MESSAGE_REJECTED",
        ...telegramDescription(response.body),
        buttons: buttons !== null,
        files: message.media.length,
        reminderId: job.id,
      }));
      if (buttons !== null) await discardReminderButtons(buttons, job.id);
      sent = refusedReminder(prepared);
      response = await send(sent, null);
    }
    if (!response.ok) {
      providerStatus = response.status;
      throw new AppError("AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED", "Telegram не принял напоминание");
    }
    const messageId = sentMessageId(response.body);
    if (!/^[1-9]\d*$/u.test(messageId)) {
      throw new AppError(
        "AGENT_REMINDER_TELEGRAM_DELIVERY_AMBIGUOUS",
        "Telegram принял напоминание, но не подтвердил идентификатор сообщения",
      );
    }
    if (buttons !== null && sent === message && message.format === "rich") {
      // The caption's later edit of this message must name its files again.
      const media = message.media.length === 0 ? [] : sentRichMediaOf(buttons.markdown, message.media, response) ?? [];
      await activateReminderButtons(buttons, messageId, media, job.id);
    }
    return { messageId, text };
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_REMINDER_TELEGRAM_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
      providerStatus,
      reminderId: job.id,
    }));
    throw error;
  }
}
