/**
 * Installation-Compose wiring for the atomic model configuration controller.
 *
 * Exports:
 * - `createInstalledModelConfigDependencies`: preflight, restart, and health operations.
 */
import { createProductionModelConfigDependencies } from "../model-config/production.js";
import type { ModelConfigCandidatePaths } from "../model-config/contracts.js";
import { ENV_PATH, resolveCurrentRelease } from "./host-layout.js";
import { runHostCommand } from "./process-runner.js";

const LOCAL_HEALTH_URL = "http://127.0.0.1:8082/v1/health";

async function compose(
  envPath: string,
  args: readonly string[],
): Promise<Buffer> {
  const release = await resolveCurrentRelease();
  return await runHostCommand({
    args: [
      "compose",
      "--env-file",
      envPath,
      "--env-file",
      release.releaseEnvPath,
      "--file",
      release.composePath,
      ...args,
    ],
    command: "docker",
    timeoutMs: 10 * 60 * 1_000,
  });
}

export function createInstalledModelConfigDependencies() {
  return createProductionModelConfigDependencies({
    health: async () => {
      const response = await fetch(LOCAL_HEALTH_URL, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("OSINARA_MODEL_CONFIG_HEALTH_FAILED: agent is unhealthy");
    },
    preflight: async (candidate: ModelConfigCandidatePaths) => {
      await compose(candidate.envPath, ["config", "--quiet"]);
      await compose(candidate.envPath, [
        "run",
        "--no-deps",
        "--rm",
        "--volume",
        `${candidate.configPath}:/app/config/agent-model-providers.json:ro`,
        "--entrypoint",
        "node",
        "agent",
        ".runtime/scripts/validate-model-provider-config.js",
      ]);
    },
    restart: async () => {
      await compose(ENV_PATH, [
        "up",
        "--detach",
        "--force-recreate",
        "--no-deps",
        "--wait",
        "--wait-timeout",
        "360",
        "agent",
      ]);
    },
  });
}
