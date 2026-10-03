/**
 * Production release contract test fixtures.
 *
 * Exports:
 * - `PRODUCTION_MEMORY_EXTRACTION_WORKER_HEALTH_COMMAND`: exact authored and resolved command.
 * - `resolvedComposeSecurityFixture`: accepted resolved production Compose security surface.
 * - `executeComposeSecurityPredicate`: invokes the real root deployment jq predicate.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("./", import.meta.url);
export const PRODUCTION_MEMORY_EXTRACTION_WORKER_HEALTH_COMMAND =
  "const fs=require('node:fs'),p='/tmp/osinara-memory-extraction-worker-ready';" +
  "if(!fs.existsSync(p)||Date.now()-fs.statSync(p).mtimeMs<30000)process.exit(1)";

export function resolvedComposeSecurityFixture(): Record<string, unknown> {
  const logging = { driver: "json-file", options: { "max-file": "5", "max-size": "20m" } };
  const volume = (source: string, target: string, type = "volume", readOnly = false) => ({
    read_only: readOnly,
    source,
    target,
    type,
  });
  const service = (extra: Record<string, unknown> = {}) => ({ logging, ...extra });

  // The fixture mirrors `docker compose config --format json`, not authored YAML shorthand.
  return {
    services: {
      agent: service({
        depends_on: {
          "cli-proxy-api": { condition: "service_healthy", required: true },
          migrate: { condition: "service_completed_successfully", required: true },
        },
        volumes: [
          volume("google-workspace-credentials", "/app/google-workspace-credentials"),
          volume("workspace-data", "/app/workspaces"),
          volume("/opt/osinara/agent-model-providers.json", "/app/config/agent-model-providers.json", "bind", true),
        ],
      }),
      "cli-proxy-api": service({
        volumes: [
          volume("cli-proxy-auth", "/var/lib/cli-proxy-api/auth"),
        ],
      }),
      edge: service({
        networks: { "app-network": null, "edge-frontend": null },
        ports: [{ host_ip: "127.0.0.1", published: "8082", target: 80 }],
      }),
      "memory-embedding": service({
        volumes: [volume("memory-embedding-model-e5", "/data")],
      }),
      "memory-embedding-worker": service(),
      "memory-extraction-worker": service({
        healthcheck: {
          retries: 120,
          test: ["CMD", "node", "-e", PRODUCTION_MEMORY_EXTRACTION_WORKER_HEALTH_COMMAND],
        },
        network_mode: "none",
      }),
      migrate: service(),
      postgres: service({ volumes: [volume("postgres-data", "/var/lib/postgresql/data")] }),
      "sandbox-egress-proxy": service(),
      "sandbox-runner": service({
        volumes: [
          volume("/var/run/docker.sock", "/var/run/docker.sock", "bind"),
          volume("tool-environments", "/runner/tools"),
          volume("workspace-data", "/runner/workspaces"),
        ],
      }),
      "sandbox-runtime-image": service(),
      "telegram-ingress-worker": service(),
    },
  };
}

export function executeComposeSecurityPredicate(config: Record<string, unknown>): void {
  execFileSync("bash", [
    "-c",
    'source "$1"; validate_resolved_compose_security -',
    "bash",
    fileURLToPath(new URL("scripts/production-deploy/release.sh", projectRoot)),
  ], { input: JSON.stringify(config), stdio: ["pipe", "pipe", "pipe"] });
}
