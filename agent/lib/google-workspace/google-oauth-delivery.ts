/**
 * Trusted Telegram delivery for Google Workspace OAuth links.
 *
 * Export:
 * - `deliverGoogleAuthorizationLink`: sends a state-bearing URL outside model context.
 */
import { sendTelegramMessage } from "../../runtime/telegram/api.js";

import { TELEGRAM_API_REQUEST_TIMEOUT_MS } from "../../config.js";
import { AppError } from "../app-error.js";
import { GOOGLE_OAUTH_STATE_TTL_MILLISECONDS } from "./google-workspace-config.js";

function botToken(): string {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  if (!value) {
    throw new Error("AGENT_TELEGRAM_CONFIG_MISSING: Не задан токен Telegram для OAuth");
  }
  return value;
}

export async function deliverGoogleAuthorizationLink(
  chatId: string,
  authorizationUrl: string,
  expiresAt: Date,
): Promise<void> {
  const signal = AbortSignal.timeout(TELEGRAM_API_REQUEST_TIMEOUT_MS);
  const fetchWithTimeout: typeof fetch = (request, init) => fetch(request, { ...init, signal });
  try {
    await sendTelegramMessage({
      body: {
        protect_content: true,
        text: [
          "Подключение Google Workspace:",
          authorizationUrl,
          `Ссылка действует до ${expiresAt.toISOString()}.`,
          "Откройте её в обычном браузере. Не пересылайте ссылку другим людям.",
        ].join("\n"),
      },
      chatId,
      credentials: { botToken: botToken() },
      fetch: fetchWithTimeout,
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_OAUTH_TELEGRAM_DELIVERY_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    // A fetch timeout is a DOMException with a read-only message, so the error is wrapped, not edited.
    throw new AppError(
      "AGENT_GOOGLE_OAUTH_TELEGRAM_DELIVERY_FAILED",
      "Telegram не подтвердил отправку ссылки для подключения Google. Проверьте личный чат; если ссылки нет, " +
        `повторите подключение через ${GOOGLE_OAUTH_STATE_TTL_MILLISECONDS / 60_000} минут, когда эта ссылка истечёт`,
      { cause: error },
    );
  }
}
