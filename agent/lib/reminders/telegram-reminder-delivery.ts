/**
 * Trusted proactive Telegram reminder delivery.
 *
 * Export:
 * - `deliverTelegramReminder`: sends deterministic text and returns its durable delivery receipt.
 *
 * Key construct:
 * - The header is bold through a Telegram `entities` span rather than a parse mode, so the reminder
 *   text written by a person is sent exactly as stored and never needs escaping.
 * - A reminder with reply buttons goes out as a rich message, the only kind that carries them, with
 *   its text kept literal; the buttons are staged before the send and activated after it. The
 *   receipt keeps the plain text either way.
 */
import { callTelegramApi } from "../../runtime/telegram/api.js";
import type { JsonObject } from "../../runtime/json.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import type { ProactiveDeliveryReceipt } from "../proactive-deliveries/proactive-delivery-repository.js";
import { reminderReplyButtons } from "../reply-buttons/reply-button-delivery.js";
import type { ClaimedReminder } from "./reminder-dispatch-repository.js";

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

const REMINDER_HEADER = "⏰ Напоминание:";

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
  buttons: { activate(messageId: string): Promise<void> },
  messageId: string,
  reminderId: string,
): Promise<void> {
  try {
    await buttons.activate(messageId);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_REMINDER_BUTTONS_ACTIVATION_FAILED",
      error: error instanceof Error ? error.message : String(error),
      reminderId,
    }));
  }
}

function reminderRequest(
  job: ClaimedReminder,
  text: string,
  buttons: { markdown: string } | null,
): { body: JsonObject; method: string } {
  const threadId = messageThreadId(job.messageThreadId);
  const thread: JsonObject = threadId === undefined ? {} : { message_thread_id: threadId };
  if (buttons !== null) {
    return { body: { chat_id: job.telegramChatId, ...thread, rich_message: { markdown: buttons.markdown } }, method: "sendRichMessage" };
  }
  // Telegram counts entity offsets in UTF-16 code units, which is what String length is.
  const entities = [{ length: REMINDER_HEADER.length, offset: 0, type: "bold" }];
  return { body: { chat_id: job.telegramChatId, entities, ...thread, text }, method: "sendMessage" };
}

export async function deliverTelegramReminder(job: ClaimedReminder): Promise<ProactiveDeliveryReceipt> {
  const delayedNotice = job.delayed
    ? `Доставлено с задержкой. Изначальное время: ${formatScheduledTime(job)} (${job.timezone}).`
    : null;
  const text = [REMINDER_HEADER, job.content, delayedNotice].filter(Boolean).join("\n\n");
  const buttons = await reminderReplyButtons({
    addresseeTelegramUserId: job.addresseeTelegramUserId,
    buttons: job.buttons,
    content: job.content,
    delayedNotice,
    reminderId: job.id,
    scope: job.scope,
    telegramChatId: job.telegramChatId,
    telegramChatType: job.telegramChatType,
  });
  const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  const fetchWithTimeout: typeof fetch = (request, init) => fetch(request, { ...init, signal });

  let providerStatus: number | undefined;
  // Telegram has no idempotency key; the durable marker is written before this boundary call.
  try {
    const response = await callTelegramApi({
      ...reminderRequest(job, text, buttons),
      botToken: requireBotToken(),
      fetch: fetchWithTimeout,
    });
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
    if (buttons !== null) await activateReminderButtons(buttons, messageId, job.id);
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
