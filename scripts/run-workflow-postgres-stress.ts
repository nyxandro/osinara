/**
 * Deterministic PostgreSQL Workflow stress runner.
 *
 * Runtime:
 * - Runs the isolated 300-turn Eve eval fixture with the repository Eve binary.
 * - Deletes generated build, discovery, and report artifacts on every exit path.
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureRoot = resolve("stress", "workflow-postgres");
const generatedPaths = [".eve", ".output", "eval-results", "reports"];
const evalName = process.argv[2] ?? "retention";
if (!["retention", "recovery"].includes(evalName) || process.argv.length > 3) throw new Error("AGENT_WORKFLOW_STRESS_INPUT_INVALID: Используйте retention или recovery");

const child = spawn(
  resolve("node_modules", ".bin", "eve"),
  ["eval", evalName, "--max-concurrency", "1", "--timeout", evalName === "recovery" ? "180000" : "2400000", "--verbose"],
  {
    cwd: fixtureRoot,
    env: process.env,
    stdio: "inherit",
  },
);
const exitCode = await new Promise<number | null>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", resolveExit);
}).finally(async () => {
  await Promise.all(generatedPaths.map((path) =>
    rm(resolve(fixtureRoot, path), { force: true, recursive: true })
  ));
});
if (exitCode !== 0) {
  throw new Error(
    `AGENT_WORKFLOW_STRESS_FAILED: PostgreSQL Workflow stress gate завершился с кодом ${String(exitCode)}`,
  );
}
