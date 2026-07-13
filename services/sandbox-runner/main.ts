/**
 * Isolated sandbox runner process entrypoint.
 *
 * Constructs:
 * - Connects exclusively to the mounted Docker socket.
 * - Discovers Compose-owned volumes/network and starts the private runner API.
 */
import Docker from "dockerode";

import {
  createDockerSandboxEngine,
  resolveSandboxDockerRuntime,
} from "./docker-sandbox-engine.js";
import { SANDBOX_IDLE_SWEEP_INTERVAL_MS } from "./docker-sandbox-lifecycle.js";
import { createSandboxRunnerServer } from "./server.js";

const RUNNER_PORT = 8080;
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";

const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });
const resources = await resolveSandboxDockerRuntime(docker);
const engine = createDockerSandboxEngine({ docker, ...resources });
await engine.stopAllSessions();
await engine.health();

const server = createSandboxRunnerServer({ engine });
server.listen(RUNNER_PORT, "0.0.0.0", () => {
  console.log("Sandbox runner ready", { port: RUNNER_PORT });
});

// Bound compute lifetime independently of agent shutdown, which may be interrupted by Docker.
const idleSweep = setInterval(() => {
  void engine.removeIdleSessions(new Date()).then((removed) => {
    if (removed > 0) console.log("Removed idle sandbox compute", { removed });
  }, (error: unknown) => {
    console.error("Sandbox idle reconciliation failed", { error });
  });
}, SANDBOX_IDLE_SWEEP_INTERVAL_MS);
idleSweep.unref();

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(idleSweep);
  console.log("Sandbox runner stopping", { signal });
  await engine.stopAllSessions();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0), (error: unknown) => {
      console.error("Sandbox runner shutdown failed", { error, signal });
      process.exit(1);
    });
  });
}
