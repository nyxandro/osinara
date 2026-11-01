/**
 * Application-owned Telegram messages of the API key intake.
 *
 * Export:
 * - `apiKeyTelegram`: sends a notice to the owner's private chat and deletes the key's message.
 *
 * These messages come from the application, not from the model: the owner reads where the key
 * will go in words the model cannot change, and the key's message is removed without the model.
 * Bot API: a bot may delete an incoming message of a private chat within 48 hours.
 */
import { callTelegramApi } from "../../runtime/telegram/api.js";

const TELEGRAM_TIMEOUT_MS = 10_000;

async function call(method: string, body: Record<string, number | string>): Promise<void> {
  const response = await callTelegramApi({
    body,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) }),
    method,
  });
  if (!response.ok) {
    throw new Error(`AGENT_API_KEY_TELEGRAM_REJECTED: Telegram rejected ${method} with HTTP ${response.status}`);
  }
}

export const apiKeyTelegram = {
  deleteMessage: (chatId: string, messageId: string) =>
    call("deleteMessage", { chat_id: chatId, message_id: Number(messageId) }),
  sendMessage: (chatId: string, text: string) => call("sendMessage", { chat_id: chatId, text }),
};
