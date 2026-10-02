/**
 * Verification of Telegram webhook requests.
 *
 * Exports:
 * - `verifyTelegramRequest`: the request body when the secret-token header matches (constant-time),
 *   or an error.
 * - `TelegramWebhookSecretToken`, `TelegramWebhookVerifier`: the two ways to configure it.
 *
 * Ported from eve 0.40.0 `public/channels/telegram/verify.ts` (Apache-2.0, see NOTICE-eve).
 * Changes: no fallback to `process.env`; a missing secret is a configuration error.
 */
import { timingSafeEqual } from "node:crypto";
/**
 * Telegram inbound-webhook verification.
 *
 * When you configure a webhook with `secret_token`, Telegram includes
 * that exact value in `X-Telegram-Bot-Api-Secret-Token` on every
 * webhook request. The native channel verifies the header directly or
 * delegates to a caller-supplied verifier for forwarded webhooks.
 */




/** Secret token you set on Telegram's `setWebhook` call. */
export type TelegramWebhookSecretToken = string | (() => string | Promise<string>);

/**
 * Caller-supplied inbound webhook verifier. Use it instead of
 * Telegram's secret-token header when an integration authenticates
 * forwarded webhooks before they reach eve.
 *
 * The return value selects how the channel handles the request: return a
 * falsy value to reject the request, a string to accept it and use that
 * string as the verified body, or any other truthy value to accept it and
 * keep the original body.
 */
export type TelegramWebhookVerifier = (
  request: Request,
  body: string,
) => unknown | Promise<unknown>;

/** Options for {@link verifyTelegramRequest}. */
export interface TelegramVerifyOptions {
  readonly secretToken: TelegramWebhookSecretToken | undefined;
  readonly webhookVerifier?: TelegramWebhookVerifier;
}

/** The configured secret; the application passes it explicitly, there is no environment fallback. */
async function resolveTelegramWebhookSecretToken(secretToken: TelegramWebhookSecretToken | undefined): Promise<string> {
  const source = typeof secretToken === "function" ? await secretToken() : secretToken;
  if (!source) throw new Error("AGENT_TELEGRAM_WEBHOOK_SECRET_MISSING: the Telegram webhook secret token is not configured");
  return source;
}

/**
 * Verifies an inbound Telegram webhook and returns its raw body.
 *
 * Throws when no secret/verifier is configured, the secret header is
 * missing, or the supplied verifier/header rejects.
 */
export async function verifyTelegramRequest(
  request: Request,
  options: TelegramVerifyOptions,
): Promise<string> {
  const body = await request.text();

  if (options.webhookVerifier !== undefined) {
    const result = await options.webhookVerifier(request, body);
    if (!result) {
      throw new Error("telegramChannel: inbound webhook verifier rejected the request.");
    }
    return typeof result === "string" ? result : body;
  }

  const secretToken = await resolveTelegramWebhookSecretToken(options.secretToken);
  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!header) {
    throw new Error("telegramChannel: inbound request missing Telegram secret-token header.");
  }
  if (!constantTimeCompare(secretToken, header)) {
    throw new Error("telegramChannel: inbound request secret-token mismatch.");
  }
  return body;
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    // Buffers of equal string length can still differ in byte length; that is a mismatch.
    return false;
  }
}
