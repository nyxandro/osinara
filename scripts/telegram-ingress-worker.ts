/**
 * Telegram ingress recovery worker.
 *
 * Constructs:
 * - Polls the agent's private drain route so leased/pending updates recover after process restarts.
 * - Uses the existing Telegram webhook secret and never exposes the route through Nginx.
 * - Reports failures as a wait until the agent first answers, within a bounded start-up grace.
 */
import { drainFailureCode } from "./telegram-ingress-drain-failure.js";

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

const drainUrl = new URL("/v1/telegram-drain", internalBaseUrl);
if (
  drainUrl.protocol !== "http:" ||
  drainUrl.hostname !== INTERNAL_AGENT_HOST ||
  drainUrl.port !== INTERNAL_AGENT_PORT ||
  drainUrl.username ||
  drainUrl.password ||
  drainUrl.pathname !== "/v1/telegram-drain"
) {
  throw new Error(
    "AGENT_TELEGRAM_WORKER_CONFIG_INVALID: Внутренний адрес drain worker должен быть безопасным HTTP URL",
  );
}

const startedAt = Date.now();
let agentAnswered = false;
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
    agentAnswered = true;
  } catch (error) {
    // This process is the polling boundary: report every failed cycle and continue the explicit
    // schedule. While the agent is still starting the cycle is a wait, not a failure.
    const message = error instanceof Error ? error.message : String(error);
    if (drainFailureCode({ agentAnswered, now: Date.now(), startedAt }) === "AGENT_TELEGRAM_DRAIN_WAITING") {
      console.info(JSON.stringify({ code: "AGENT_TELEGRAM_DRAIN_WAITING", error: message }));
    } else {
      console.error(JSON.stringify({ code: "AGENT_TELEGRAM_DRAIN_FAILED", error: message }));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, DRAIN_INTERVAL_MS));
}
