/**
 * One-time update of the Telegram webhook's subscription on a running server (#465).
 *
 * Exports:
 * - `ensureTelegramWebhookSubscription`: keeps the webhook's address and secret and subscribes it to
 *   every update type the application handles; does nothing when it already is.
 *
 * Run inside the agent container after the release that added `my_chat_member`:
 * `node .runtime/scripts/telegram-webhook-subscription.js`. Telegram keeps the previous subscription
 * until the next `setWebhook`, so without this a running server never hears that the bot was removed
 * from a group. The secret is sent again on purpose: a `setWebhook` without it would drop it. Pending
 * updates are kept.
 */
import { TELEGRAM_ALLOWED_UPDATES } from "./provider-installer/telegram-webhook.js";

type TelegramCall = (method: string, body?: Record<string, unknown>) => Promise<{ ok?: boolean; result?: unknown }>;

function subscribed(result: unknown): readonly string[] {
  const updates = (result as { allowed_updates?: unknown } | null)?.allowed_updates;
  return Array.isArray(updates) ? updates.filter((value): value is string => typeof value === "string") : [];
}

export async function ensureTelegramWebhookSubscription(input: {
  call: TelegramCall;
  secretToken: string;
}): Promise<"already_subscribed" | "subscribed"> {
  const info = await input.call("getWebhookInfo");
  const url = (info.result as { url?: unknown } | null)?.url;
  if (info.ok !== true || typeof url !== "string" || url === "") {
    throw new Error("AGENT_TELEGRAM_WEBHOOK_NOT_SET: Telegram reports no webhook address; finish the installation first");
  }
  if (TELEGRAM_ALLOWED_UPDATES.every((type) => subscribed(info.result).includes(type))) return "already_subscribed";
  const set = await input.call("setWebhook", {
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    secret_token: input.secretToken,
    url,
  });
  if (set.ok !== true || set.result !== true) {
    throw new Error("AGENT_TELEGRAM_WEBHOOK_SET_FAILED: Telegram did not accept the webhook subscription");
  }
  const verified = await input.call("getWebhookInfo");
  if (!TELEGRAM_ALLOWED_UPDATES.every((type) => subscribed(verified.result).includes(type))) {
    throw new Error("AGENT_TELEGRAM_WEBHOOK_VERIFY_FAILED: Telegram did not confirm the new subscription");
  }
  return "subscribed";
}

function requiredEnv(name: "TELEGRAM_BOT_TOKEN" | "TELEGRAM_WEBHOOK_SECRET_TOKEN"): string {
  const value = process.env[name];
  if (!value) throw new Error(`AGENT_TELEGRAM_CONFIG_MISSING: ${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const token = requiredEnv("TELEGRAM_BOT_TOKEN");
  const outcome = await ensureTelegramWebhookSubscription({
    async call(method, body) {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      return await response.json() as { ok?: boolean; result?: unknown };
    },
    secretToken: requiredEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
  });
  console.info(JSON.stringify({ code: "AGENT_TELEGRAM_WEBHOOK_SUBSCRIPTION", outcome }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
