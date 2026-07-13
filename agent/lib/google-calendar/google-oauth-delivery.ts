/**
 * Trusted Telegram delivery for Google OAuth links and completion notices.
 *
 * Export:
 * - `deliverGoogleAuthorizationLink`: sends a state-bearing URL outside model context.
 */
import { sendTelegramMessage } from "eve/channels/telegram";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";

function botToken(): string {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) {
    throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задан токен Telegram для OAuth");
  }
  return value;
}

async function sendPrivateText(chatId: string, text: string): Promise<void> {
  const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  const fetchWithTimeout: typeof fetch = (request, init) => fetch(request, { ...init, signal });
  try {
    await sendTelegramMessage({
      body: { protect_content: true, text },
      chatId,
      credentials: { botToken: botToken() },
      fetch: fetchWithTimeout,
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_OAUTH_TELEGRAM_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_OAUTH_TELEGRAM_DELIVERY_FAILED: Не удалось отправить OAuth-ссылку";
    }
    throw error;
  }
}

export async function deliverGoogleAuthorizationLink(
  chatId: string,
  authorizationUrl: string,
  expiresAt: Date,
): Promise<void> {
  await sendPrivateText(chatId, [
    "Подключение Google Calendar:",
    authorizationUrl,
    `Ссылка действует до ${expiresAt.toISOString()}.`,
    "Откройте её в обычном браузере. Не пересылайте ссылку другим людям.",
  ].join("\n"));
}
