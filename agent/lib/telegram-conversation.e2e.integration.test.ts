/** Run the real application channel and native Eve lifecycle against the isolated test database. */
import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const run = promisify(execFile);

describeWithDatabase("Telegram conversation end-to-end", () => {
  it("answers humans and bots through a new session after 50 turns", async () => {
    const root = resolve("stress/telegram-conversation");
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
    await cp(resolve("config"), resolve(root, "config"), { recursive: true });
    try {
      await run(resolve("node_modules/.bin/tsc"), ["--project", resolve(root, "tsconfig.json")], { env });
      const result = await run(resolve("node_modules/.bin/eve"), [
        "eval", "conversation", "--max-concurrency", "1", "--timeout", "240000", "--verbose",
      ], {
        cwd: root,
        env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 300_000,
      });
       expect(result.stdout).toContain("verified 56 turns, 4 sessions");
       expect(result.stdout).toContain("verified restart recovery without repeating model calls, tools or Telegram delivery");
      expect(result.stdout).toContain("verified mandatory preparation failure stops before the model");
      expect(result.stdout).toContain("verified native cancellation stops a running model without a late reply");
      expect(result.stderr).not.toContain("AGENT_MEMORY_UNAVAILABLE");
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      throw new Error(`TEST_TELEGRAM_CONVERSATION_FAILED: ${output.stdout ?? ""}\n${output.stderr ?? ""}`, { cause: error });
    } finally {
      await Promise.all([".eve", ".output", "eval-results", "reports", "config"].map((path) =>
        rm(resolve(root, path), { recursive: true, force: true })
      ));
    }
  }, 310_000);
});
