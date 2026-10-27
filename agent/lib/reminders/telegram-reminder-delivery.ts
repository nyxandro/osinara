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
 *   its text kept literal; the buttons are staged before the send and activated after it. When
 *   Telegram refuses that message, nothing was delivered, so the reminder goes once more as an
 *   ordinary message and its buttons are discarded. The receipt keeps the plain text either way.
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
  let providerStatus: number | undefined;
  // Each send has its own time: a second send after a refusal must not inherit what is left.
  const send = async (withButtons: { markdown: string } | null) => {
    const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
    return await callTelegramApi({
      ...reminderRequest(job, text, withButtons),
      botToken: requireBotToken(),
      fetch: (request, init) => fetch(request, { ...init, signal }),
    });
  };
  // Telegram has no idempotency key; the durable marker is written before this boundary call.
  try {
    let response = await send(buttons);
    let buttonsSent = buttons !== null;
    if (!response.ok && buttons !== null && response.status === TELEGRAM_BAD_REQUEST_STATUS) {
      // A refusal delivered nothing, so the reminder itself still goes, as it would without buttons.
      console.error(JSON.stringify({
        code: "AGENT_REMINDER_BUTTONS_REJECTED",
        ...telegramDescription(response.body),
        reminderId: job.id,
      }));
      await discardReminderButtons(buttons, job.id);
      buttonsSent = false;
      response = await send(null);
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
    if (buttons !== null && buttonsSent) await activateReminderButtons(buttons, messageId, job.id);
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
