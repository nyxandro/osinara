/**
 * Subscribes Telegram's beta Bot API server to the bot's webhook for widget presses only (#468), or
 * removes that subscription.
 *
 * Why a second subscription: on 06.11.2026 the widget methods of Bot API 10.4 lived only on the beta
 * server, a separate server with its own queue and numbering of the bot's updates (copies of every
 * message too). Presses (`widget_query`) come only from it. So it is subscribed to the same webhook
 * address, with a secret of its own (`widget-webhook-secret.ts`), for presses only, and with its
 * pending updates dropped — otherwise hundreds of copies of old messages would arrive and be answered
 * a second time. The regular subscription is read, never changed.
 *
 * Run inside the agent container (it is built into `.runtime`), after the release that handles presses is live:
 *   node .runtime/scripts/widgets/subscribe-beta-widget-queries.js          # subscribe and check
 *   node .runtime/scripts/widgets/subscribe-beta-widget-queries.js --remove # roll back
 * Prints the checks, never the token, the secret or the webhook address.
 */
import { widgetWebhookSecret } from "../../agent/lib/widgets/widget-webhook-secret.js";
import { TELEGRAM_WIDGET_API_BASE_URL } from "../../agent/lib/widgets/widget-config.js";

const REGULAR_API = "https://api.telegram.org";
const WIDGET_UPDATES = ["widget_query"] as const;

interface WebhookInfo {
  readonly allowed_updates?: readonly string[];
  readonly last_error_message?: string;
  readonly pending_update_count?: number;
  readonly url?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`AGENT_WIDGET_SUBSCRIPTION_CONFIG_MISSING: ${name} is not set`);
  return value;
}

async function call<T>(base: string, token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${base}/bot${token}/${method}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const parsed = await response.json() as { ok?: boolean; result?: T; description?: string };
  if (parsed.ok !== true) throw new Error(`AGENT_WIDGET_SUBSCRIPTION_FAILED: ${method}: ${parsed.description ?? response.status}`);
  return parsed.result as T;
}

function summary(info: WebhookInfo): Record<string, unknown> {
  return {
    allowedUpdates: info.allowed_updates ?? null,
    lastError: info.last_error_message ?? null,
    pending: info.pending_update_count ?? 0,
    subscribed: Boolean(info.url),
  };
}

async function main(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const remove = process.argv.includes("--remove");
  const regularBefore = await call<WebhookInfo>(REGULAR_API, token, "getWebhookInfo");
  if (remove) {
    await call(TELEGRAM_WIDGET_API_BASE_URL, token, "deleteWebhook", { drop_pending_updates: true });
  } else {
    if (!regularBefore.url) throw new Error("AGENT_WIDGET_SUBSCRIPTION_NO_WEBHOOK: the regular webhook is not set, so there is no address to share");
    await call(TELEGRAM_WIDGET_API_BASE_URL, token, "setWebhook", {
      allowed_updates: WIDGET_UPDATES,
      drop_pending_updates: true,
      secret_token: widgetWebhookSecret(required("TELEGRAM_WEBHOOK_SECRET_TOKEN")),
      url: regularBefore.url,
    });
  }
  const regularAfter = await call<WebhookInfo>(REGULAR_API, token, "getWebhookInfo");
  const beta = await call<WebhookInfo>(TELEGRAM_WIDGET_API_BASE_URL, token, "getWebhookInfo");
  const regularUnchanged = regularAfter.url === regularBefore.url
    && JSON.stringify(regularAfter.allowed_updates) === JSON.stringify(regularBefore.allowed_updates);
  const betaExpected = remove
    ? !beta.url
    : beta.url === regularBefore.url && JSON.stringify(beta.allowed_updates) === JSON.stringify(WIDGET_UPDATES);
  console.log(JSON.stringify({ action: remove ? "remove" : "subscribe", beta: summary(beta), betaExpected, regular: summary(regularAfter), regularUnchanged }, null, 2));
  if (!regularUnchanged || !betaExpected) process.exitCode = 1;
}

await main();
