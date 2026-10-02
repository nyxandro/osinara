/**
 * One-shot capture of the golden Eve model requests.
 *
 * Runs the `reference` eval of the bench; the eval writes the normalized requests into
 * `agent/runtime/testing/eve-0.40-requests/`. Run it inside the test container (see
 * `compose.test.yaml`) with that directory mounted from the working tree.
 */
import { runTelegramConversationBench } from "./bench-runner.ts";

try {
  const result = await runTelegramConversationBench("reference");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} catch (error) {
  const output = error as { stderr?: string; stdout?: string };
  process.stdout.write(output.stdout ?? "");
  process.stderr.write(output.stderr ?? "");
  throw new Error("TEST_REFERENCE_CAPTURE_FAILED: the reference eval did not complete", { cause: error });
}
