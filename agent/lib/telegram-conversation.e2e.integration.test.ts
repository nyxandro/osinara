/** Run the real application channel and native Eve lifecycle against the isolated test database. */
import { describe, expect, it } from "vitest";

import { runTelegramConversationBench } from "../../stress/telegram-conversation/bench-runner.ts";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("Telegram conversation end-to-end", () => {
  it("answers humans and bots through a new session after 50 turns", async () => {
    try {
      const result = await runTelegramConversationBench("conversation");
       expect(result.stdout).toContain("verified 56 turns, 4 sessions");
       expect(result.stdout).toContain("verified restart recovery without repeating model calls, tools or Telegram delivery");
       expect(result.stdout).toContain("verified real profile approval executes once and survives empty audit turn IDs");
      expect(result.stdout).toContain("verified mandatory preparation failure stops before the model");
      expect(result.stdout).toContain("verified native cancellation stops a running model without a late reply");
      expect(result.stdout).toContain("verified silent group turn delivers nothing and keeps the trigger reason");
      expect(result.stderr).not.toContain("AGENT_MEMORY_UNAVAILABLE");
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      throw new Error(`TEST_TELEGRAM_CONVERSATION_FAILED: ${output.stdout ?? ""}\n${output.stderr ?? ""}`, { cause: error });
    }
  }, 310_000);
});
