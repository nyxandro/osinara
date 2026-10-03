/**
 * The agent process: the one backend that receives Telegram, runs turns and the minute schedules.
 *
 * Starts the application (`agent/application.ts`) on port 3000 with the production model, sandbox
 * runner and Telegram bot from the environment.
 *
 * Stop (SIGTERM, SIGINT): no new requests or schedule cycles; running work gets a bounded time.
 * What is still running then continues at the next start from the journal: a turn is never marked
 * cancelled by a stopping process.
 *
 * Exit with code 1 at once when another agent process took the database over while this one had
 * lost its connection (`AGENT_RUNTIME_SECOND_PROCESS`): the other one continues the turns.
 */
import { createOsinaraAgent } from "./agent.js";
import { startApplication } from "./application.js";
import { SANDBOX_RUNNER_BASE_URL } from "./config.js";
import { closeDatabase } from "./lib/database.js";
import { runtimeProcessIdentity } from "./lib/runtime-admission-reconciliation.js";

// The port Docker, Nginx, the ingress worker and the deploy controller already use.
const HTTP_PORT = 3000;
const HTTP_HOST = "0.0.0.0";
// Docker stops a container ten seconds after SIGTERM; the database is closed inside that window.
const SHUTDOWN_GRACE_MILLISECONDS = 8_000;

function requiredEnv(name: "TELEGRAM_BOT_TOKEN" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_WEBHOOK_SECRET_TOKEN"): string {
  const value = process.env[name];
  if (!value) throw new Error(`AGENT_CONFIG_MISSING: ${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const identity = await runtimeProcessIdentity();
  const application = await startApplication({
    agent: createOsinaraAgent(),
    botToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
    botUsername: requiredEnv("TELEGRAM_BOT_USERNAME"),
    host: HTTP_HOST,
    onRunnerLockTaken: () => process.exit(1),
    port: HTTP_PORT,
    runnerId: `${identity.hostname}:${identity.pid}:${identity.startTicks}`,
    sandboxRunnerBaseUrl: SANDBOX_RUNNER_BASE_URL,
    webhookSecretToken: requiredEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ code: "AGENT_RUNTIME_STOPPING", signal }));
    await application.stop(SHUTDOWN_GRACE_MILLISECONDS);
    await closeDatabase();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ code: "AGENT_RUNTIME_START_FAILED", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
