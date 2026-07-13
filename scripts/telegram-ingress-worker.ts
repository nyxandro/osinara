/**
 * Telegram ingress recovery worker.
 *
 * Constructs:
 * - Polls the private Eve drain route so leased/pending updates recover after process restarts.
 * - Uses the existing Telegram webhook secret and never exposes the route through Nginx.
 */
export {};

const DRAIN_INTERVAL_MS = 5_000;
const DRAIN_REQUEST_TIMEOUT_MS = 15_000;
const INTERNAL_AGENT_HOST = "agent";
const INTERNAL_AGENT_PORT = "3000";
const internalBaseUrl = process.env.AGENT_INTERNAL_BASE_URL;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;

if (!internalBaseUrl || !webhookSecret) {
  throw new Error(
    "AGENT_TELEGRAM_WORKER_CONFIG_MISSING: Не заданы внутренний адрес агента или Telegram webhook secret",
  );
}

const drainUrl = new URL("/eve/v1/telegram-drain", internalBaseUrl);
if (
  drainUrl.protocol !== "http:" ||
  drainUrl.hostname !== INTERNAL_AGENT_HOST ||
  drainUrl.port !== INTERNAL_AGENT_PORT ||
  drainUrl.username ||
  drainUrl.password ||
  drainUrl.pathname !== "/eve/v1/telegram-drain"
) {
  throw new Error(
    "AGENT_TELEGRAM_WORKER_CONFIG_INVALID: Внутренний адрес drain worker должен быть безопасным HTTP URL",
  );
}

while (true) {
  try {
    const response = await fetch(drainUrl, {
      body: "{}",
      headers: { "x-telegram-bot-api-secret-token": webhookSecret },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(DRAIN_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`AGENT_TELEGRAM_DRAIN_HTTP_FAILED: drain returned HTTP ${response.status}`);
    }
  } catch (error) {
    // This process is the polling boundary: report every failed cycle and continue the explicit schedule.
    console.error(
      JSON.stringify({
        code: "AGENT_TELEGRAM_DRAIN_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, DRAIN_INTERVAL_MS));
}
