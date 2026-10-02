/**
 * The application under test: the production composition with doubles for the world outside it.
 *
 * Run as its own process by the end-to-end test (`node --import tsx agent/e2e/application-under-test.ts`),
 * so the test can kill it in the middle of a turn and start another one on the same database.
 *
 * Real: the webhook, the durable ingress, the runtime and its journal, every application tool and
 * prompt block, the sandbox code with the runner client and the runner's HTTP server.
 * Doubles: the model provider (`scripted-model.ts`), Telegram's Bot API and the embedding service
 * (`telegram-double.ts`), the runner's Docker engine (`sandbox-engine-double.ts`).
 *
 * Environment: `DATABASE_URL` (the `*_test` database) and the usual required secrets; `E2E_RUNNER_ID`
 * names this process in the turn journal and `E2E_SANDBOX_ROOT` holds its sandbox folders. It
 * prints `AGENT_RUNTIME_STARTED` with the port it listens on.
 *
 * Test-only.
 */
import { database } from "../lib/database.js";
import { installNetworkDouble } from "./telegram-double.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`TEST_E2E_CONFIG_MISSING: ${name}`);
  return value;
}

if (!new URL(required("DATABASE_URL")).pathname.endsWith("_test")) throw new Error("AGENT_TEST_DATABASE_UNSAFE");
const db = database();
installNetworkDouble(db);

// Imported after the network double, so no module captures the real `fetch` first.
const { createSandboxRunnerServer } = await import("../../services/sandbox-runner/server.js");
const { createSandboxEngineDouble } = await import("./sandbox-engine-double.js");
const { createScriptedModel } = await import("./scripted-model.js");
const { createOsinaraAgent } = await import("../agent.js");
const { startApplication } = await import("../application.js");

const runner = createSandboxRunnerServer({ engine: createSandboxEngineDouble({ db, root: required("E2E_SANDBOX_ROOT") }) });
const runnerPort = await new Promise<number>((resolve) => {
  runner.listen(0, "127.0.0.1", () => {
    const address = runner.address();
    if (address === null || typeof address === "string") throw new Error("TEST_RUNNER_ADDRESS_MISSING");
    resolve(address.port);
  });
});

const model = createScriptedModel(db);
const agent = createOsinaraAgent();
const application = await startApplication({
  agent: { ...agent, selectModel: () => ({ contextWindowTokens: 1_000_000, model, providerOptions: undefined }) },
  botToken: required("TELEGRAM_BOT_TOKEN"),
  botUsername: required("TELEGRAM_BOT_USERNAME"),
  host: "127.0.0.1",
  port: 0,
  runnerId: required("E2E_RUNNER_ID"),
  sandboxRunnerBaseUrl: `http://127.0.0.1:${runnerPort}/`,
  webhookSecretToken: required("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
});

process.once("SIGTERM", () => {
  void application.stop(2_000).then(() => runner.close()).then(() => process.exit(0));
});
