/**
 * Launcher for the Telegram conversation bench on native Eve.
 *
 * Export:
 * - `runTelegramConversationBench`: resets the disposable Workflow database, copies the production
 *   inputs into the bench, type-checks it and runs one named eval against a local dev server.
 *
 * The bench re-exports the real channel, tool surface, instructions resolvers and schedules; the
 * production `instructions.md` and `config/` are copied in for the run, so every model request
 * carries exactly what production composes. Only the model and the Telegram network are doubles.
 */
import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const BENCH_ROOT = resolve("stress/telegram-conversation");
const PRODUCTION_INPUTS = ["config", "agent/instructions.md"] as const;
const RUN_ARTIFACTS = [".eve", ".output", "eval-results", "reports"] as const;
const EVAL_TIMEOUT_MILLISECONDS = 240_000;
const PROCESS_TIMEOUT_MILLISECONDS = 300_000;

export async function runTelegramConversationBench(
  evalName: string,
): Promise<{ stderr: string; stdout: string }> {
  const env = {
    ...process.env,
    // Eve's NODE_ENV=test bypasses authored models/sandboxes, which would hide startup failures.
    NODE_ENV: "development",
    EVE_MOCK_AUTHORED_MODELS: "0",
    TELEGRAM_BOT_TOKEN: "conversation-test-token",
    TELEGRAM_BOT_USERNAME: "osinara_bot",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "conversation-test-secret",
    MODEL_API_KEY: "unused-test-key",
    MEMORY_EMBEDDING_BASE_URL: "http://memory-test",
    WORKFLOW_STRESS_RESET_ALLOWED: "true",
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "10",
    WORKFLOW_POSTGRES_MAX_POOL_SIZE: "12",
  };
  await run(process.execPath, ["--experimental-strip-types", "scripts/reset-workflow-stress-database.ts"], { env });
  await run(process.execPath, ["--experimental-strip-types", "scripts/migrate-workflow.ts"], { env });
  for (const input of PRODUCTION_INPUTS) {
    await cp(resolve(input), resolve(BENCH_ROOT, input), { recursive: true });
  }
  try {
    await run(resolve("node_modules/.bin/tsc"), ["--project", resolve(BENCH_ROOT, "tsconfig.json")], { env });
    return await run(resolve("node_modules/.bin/eve"), [
      "eval", evalName, "--max-concurrency", "1", "--timeout", String(EVAL_TIMEOUT_MILLISECONDS), "--verbose",
    ], {
      cwd: BENCH_ROOT,
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: PROCESS_TIMEOUT_MILLISECONDS,
    });
  } finally {
    await Promise.all([...RUN_ARTIFACTS, ...PRODUCTION_INPUTS].map((path) =>
      rm(resolve(BENCH_ROOT, path), { recursive: true, force: true })
    ));
  }
}
