/**
 * Telegram webhook registration boundary.
 *
 * Exports:
 * - `ConfigureTelegramWebhookOptions`: explicit credentials, target, fetch, and timeout inputs.
 * - `configureTelegramWebhook`: sets and verifies the exact Osinara webhook without dropping updates.
 */
import { InstallerError } from "./errors.js";

const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const TELEGRAM_WEBHOOK_PATH = "/v1/telegram";
const MAX_TIMEOUT_MS = 120_000;
const BOT_TOKEN_PATTERN = /^[0-9]+:[A-Za-z0-9_-]+$/u;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

export interface ConfigureTelegramWebhookOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly hostname: string;
  readonly secretToken: string;
  readonly timeoutMs: number;
  readonly token: string;
}

interface TelegramWebhookResponse {
  readonly ok: boolean;
  readonly result?: unknown;
}

async function telegramJson(
  options: ConfigureTelegramWebhookOptions,
  method: "getWebhookInfo" | "setWebhook",
  body?: Record<string, unknown>,
): Promise<TelegramWebhookResponse> {
  try {
    const response = await options.fetch(`${TELEGRAM_API_ORIGIN}/bot${options.token}/${method}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error("Telegram returned a non-success status");
    const decoded: unknown = await response.json();
    if (typeof decoded !== "object" || decoded === null || !("ok" in decoded)) {
      throw new Error("Telegram returned an invalid payload");
    }
    return decoded as TelegramWebhookResponse;
  } catch (error) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_WEBHOOK_REQUEST_FAILED",
      "Не удалось настроить webhook Telegram. Проверьте сеть и повторите операцию",
      { cause: error },
    );
  }
}

/** Registers the exact public target and confirms Telegram persisted the same URL. */
export async function configureTelegramWebhook(
  options: ConfigureTelegramWebhookOptions,
): Promise<void> {
  if (
    !BOT_TOKEN_PATTERN.test(options.token)
    || !HOSTNAME_PATTERN.test(options.hostname)
    || !SECRET_PATTERN.test(options.secretToken)
    || !Number.isInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_WEBHOOK_INPUT_INVALID",
      "Для настройки webhook переданы некорректный адрес, токен, секрет или таймаут",
    );
  }

  const targetUrl = `https://${options.hostname}${TELEGRAM_WEBHOOK_PATH}`;
  const registered = await telegramJson(options, "setWebhook", {
    allowed_updates: ["message", "callback_query"],
    secret_token: options.secretToken,
    url: targetUrl,
  });
  if (registered.ok !== true || registered.result !== true) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_WEBHOOK_SET_FAILED",
      "Telegram не принял новый webhook. Проверьте доступность HTTPS-адреса",
    );
  }

  const status = await telegramJson(options, "getWebhookInfo");
  const result = status.result;
  if (
    status.ok !== true
    || typeof result !== "object"
    || result === null
    || !("url" in result)
    || result.url !== targetUrl
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_TELEGRAM_WEBHOOK_VERIFY_FAILED",
      "Telegram не подтвердил точный webhook Osinara. Проверьте HTTPS и повторите установку",
    );
  }
}
