/**
 * Production release contract test fixtures.
 *
 * Exports:
 * - `resolvedComposeSecurityFixture`: accepted resolved production Compose security surface.
 * - `installationComposeSecurityFixture`: the same surface without the CLIProxy gateway.
 * - `executeComposeSecurityPredicate`: invokes the real root deployment jq predicate for a profile.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("./", import.meta.url);

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

/** The installation graph: what `installation-compose.jq` leaves of the production graph. */
export function installationComposeSecurityFixture(): Record<string, unknown> {
  const config = resolvedComposeSecurityFixture() as {
    services: Record<string, { depends_on?: Record<string, unknown> }>;
  };
  delete config.services["cli-proxy-api"];
  delete config.services.agent!.depends_on!["cli-proxy-api"];
  return config;
}

export function executeComposeSecurityPredicate(
  config: Record<string, unknown>,
  profile: "installation" | "production",
): void {
  execFileSync("bash", [
    "-c",
    'source "$1"; validate_resolved_compose_security - "$2"',
    "bash",
    fileURLToPath(new URL("scripts/production-deploy/release.sh", projectRoot)),
    profile,
  ], { input: JSON.stringify(config), stdio: ["pipe", "pipe", "pipe"] });
}
