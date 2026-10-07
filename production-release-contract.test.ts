/**
 * Production release and deployment contract tests.
 *
 * Constructs covered:
 * - Container-only first-party Docker targets and OCI provenance labels.
 * - Digest-only production Compose wiring, migration ordering, and isolation boundaries.
 * - Main-only GHCR release workflow with pinned actions and artifact attestations.
 * - Server-only deployment locking, validation, backup, status, and notification flow.
 * - Root-owned systemd polling units and required production environment documentation.
 * - The exact production jq security predicate accepts only the intended resolved Compose surface.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  executeComposeSecurityPredicate,
  resolvedComposeSecurityFixture,
} from "./production-release-contract-fixtures.js";

const projectRoot = new URL("./", import.meta.url);

function readProjectFile(path: string): string {
  return readFileSync(new URL(path, projectRoot), "utf8");
}

function readDeployScripts(): { combined: string; files: Array<{ path: string; source: string }> } {
  const moduleDirectory = new URL("scripts/production-deploy/", projectRoot);
  const paths = readdirSync(moduleDirectory)
    .filter((name) => name.endsWith(".sh"))
    .sort()
    .map((name) => `scripts/production-deploy/${name}`);
  const files = paths.map((path) => ({ path, source: readProjectFile(path) }));
  return { combined: files.map(({ source }) => source).join("\n"), files };
}

function service(compose: string, name: string, nextName: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  const end = compose.indexOf(`\n  ${nextName}:\n`, start + 1);
  expect(start, `${name} service is absent`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} service boundary is absent`).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("production container contract", () => {
  it("publishes six container-only first-party targets with OCI provenance", () => {
    const dockerfile = readProjectFile("Dockerfile");
    const entrypoint = readProjectFile("scripts/docker-entrypoint.sh");

    for (const target of [
      "runtime",
      "cli-proxy",
      "sandbox-runtime",
      "sandbox-runner",
      "sandbox-egress-proxy",
      "edge",
    ]) {
      expect(dockerfile).toContain(` AS ${target}`);
    }
    expect(dockerfile).toContain("ARG OCI_SOURCE");
    expect(dockerfile).toContain("ARG OCI_VERSION");
    expect(dockerfile).toContain("ARG OCI_REVISION");
    expect(dockerfile).toContain("org.opencontainers.image.source=\"${OCI_SOURCE}\"");
    expect(dockerfile).toContain("org.opencontainers.image.version=\"${OCI_VERSION}\"");
    expect(dockerfile).toContain("org.opencontainers.image.revision=\"${OCI_REVISION}\"");
    expect(dockerfile).toContain("COPY infra/nginx.conf /etc/nginx/nginx.conf");
    expect(dockerfile).toContain(
      "FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5",
    );
    expect(dockerfile).toContain(
      "FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
    );
    expect(dockerfile).toContain(
      "FROM eceasy/cli-proxy-api@sha256:591a09c19de769be09a2e56277365cd568b83fc7d98c94d2e7e7bef7069f7422 AS cli-proxy",
    );

    // The agent runs bundled; its authored tree stays for `instructions.md` and operator `tsx` commands.
    const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
    expect(runtime).toContain("COPY --from=build /app/.runtime ./.runtime");
    expect(runtime).toContain("COPY --from=build /app/agent ./agent");
    expect(entrypoint).toContain("exec node .runtime/agent/main.js");
    expect(entrypoint).not.toContain("npm run start");
    expect(runtime).not.toMatch(/COPY --from=build \/app\/(scripts|services)\b/);
    expect(entrypoint).toContain("node .runtime/scripts/migrate.js");
    expect(entrypoint).toContain("node .runtime/scripts/validate-model-provider-config.js");
    expect(entrypoint).not.toContain("npm run migrate");
  });

  // The app image is the only digest the approved manifest binds that a host can read files from,
  // so the controller and its units travel inside it, outside the agent's own tree.
  it("ships the deployment controller and its units in the app image", () => {
    const dockerfile = readProjectFile("Dockerfile");
    const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"), dockerfile.indexOf(" AS edge"));

    expect(runtime).toContain("COPY scripts/production-deploy/ ./deploy/controller/");
    expect(runtime).toContain("COPY infra/systemd/ ./deploy/systemd/");
    expect(readdirSync(new URL("scripts/production-deploy/", projectRoot)).sort()).toEqual([
      "backup.sh",
      "common.sh",
      "database.sh",
      "installation-compose.jq",
      "launcher.sh",
      "main.sh",
      "release.sh",
      "self-update.sh",
    ]);
    expect(readdirSync(new URL("infra/systemd/", projectRoot)).sort()).toEqual([
      "osinara-deploy.service",
      "osinara-deploy.timer",
    ]);
  });

  it("installs dependencies without install-time scripts", () => {
    const dockerfile = readProjectFile("Dockerfile");
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(dockerfile).not.toContain("npm run postinstall");
    expect(dockerfile).toContain("RUN npm ci --ignore-scripts \\\n    && npm run install:gws");
    expect(dockerfile).toContain("RUN npm ci --omit=dev --ignore-scripts \\\n    && npm run install:gws");
    expect(packageJson.scripts).not.toHaveProperty("postinstall");
    expect(packageJson.scripts["migrate:runtime"]).toBe("node .runtime/scripts/migrate.js");
  });

  it("pins the official Russian root CA inside the sandbox runtime", () => {
    const dockerfile = readProjectFile("Dockerfile");
    const certificate = new X509Certificate(
      readProjectFile("infra/certificates/russian-trusted-root-ca.crt"),
    );

    expect(certificate.subject).toContain("CN=Russian Trusted Root CA");
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.ca).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.fingerprint256).toBe(
      "D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31",
    );
    expect(dockerfile).toContain(
      "COPY infra/certificates/russian-trusted-root-ca.crt /usr/local/share/ca-certificates/russian-trusted-root-ca.crt",
    );
    expect(dockerfile).toContain("update-ca-certificates");
  });

  it("uses only required digest references and one shared app image", () => {
    const compose = readProjectFile("compose.production.yaml");

    expect(compose).toContain("name: osinara-production\n");
    expect(compose).not.toMatch(/^\s+build:/m);
    expect(compose).not.toMatch(/^\s+-\s+\.\.?\//m);
    expect(compose).not.toMatch(/:\s*\.\.?\//m);

    const requiredImages = [
      "OSINARA_APP_IMAGE",
      "OSINARA_CLI_PROXY_IMAGE",
      "SANDBOX_RUNTIME_IMAGE",
      "OSINARA_SANDBOX_RUNNER_IMAGE",
      "OSINARA_SANDBOX_EGRESS_PROXY_IMAGE",
      "OSINARA_EDGE_IMAGE",
    ];
    for (const image of requiredImages) {
      expect(compose).toContain(`image: \${${image}:?`);
    }
    expect(compose.match(/image: \$\{OSINARA_APP_IMAGE:\?/g)).toHaveLength(4);
    expect(compose).toContain("SANDBOX_RUNTIME_IMAGE: ${SANDBOX_RUNTIME_IMAGE:?");
    expect(compose.match(/DATABASE_URL: \$\{DATABASE_URL:\?/g)).toHaveLength(3);
    expect(compose).not.toContain("DATABASE_URL: postgresql://");
  });

  // The background memory pipeline was retired in v0.12.0; its idle worker left in v0.40.2.
  it("ships no retired memory extraction worker", () => {
    const { combined: script } = readDeployScripts();

    expect(readProjectFile("compose.production.yaml")).not.toContain("memory-extraction-worker");
    expect(script).not.toContain("memory-extraction-worker");
  });

  it("gates the agent on migration and keeps stable state and ingress", () => {
    const compose = readProjectFile("compose.production.yaml");
    const agent = service(compose, "agent", "migrate");
    const migrate = service(compose, "migrate", "memory-embedding-worker");
    const edge = service(compose, "edge", "sandbox-runtime-image");

    expect(agent).toContain("migrate:\n        condition: service_completed_successfully");
    expect(agent).toContain('command: ["start-after-migration"]');
    expect(migrate).toContain("restart: \"no\"");
    expect(migrate).toContain('entrypoint: ["npm", "run", "migrate:runtime"]');
    expect(agent).toContain("healthcheck:");
    expect(agent).toContain("retries: 72");
    expect(edge).toContain("healthcheck:");
    expect(edge).toContain('"127.0.0.1:8082:80"');

    for (const volume of [
      "postgres-data",
      "memory-embedding-model-e5",
      "google-workspace-credentials",
      "tool-environments",
      "workspace-data",
      "cli-proxy-auth",
    ]) {
      const physicalName = `osinara-production-${volume}`;
      expect(compose).toMatch(new RegExp(`  ${volume}:\\n    name: ${physicalName}\\n`));
    }
    for (const network of ["app-network", "sandbox-control", "sandbox-egress"]) {
      expect(compose).toMatch(
        new RegExp(`  ${network}:\\n(?:    internal: true\\n)?    name: osinara-production-${network}\\n`),
      );
    }
  });

  it("bounds production container logs in every service", () => {
    const compose = readProjectFile("compose.production.yaml");

    expect(compose).toContain("x-bounded-json-logs: &bounded-json-logs");
    expect(compose).toContain('max-size: "20m"');
    expect(compose).toContain('max-file: "5"');
    expect(compose.match(/logging: \*bounded-json-logs/g)).toHaveLength(11);
  });

  it("limits Docker control to the runner and pins every production image", () => {
    const compose = readProjectFile("compose.production.yaml");
    const agent = service(compose, "agent", "migrate");
    const runner = service(compose, "sandbox-runner", "sandbox-egress-proxy");

    expect(compose.match(/\/var\/run\/docker\.sock/g)).toHaveLength(2);
    expect(agent).not.toContain("/var/run/docker.sock");
    expect(agent).toContain("google-workspace-credentials:/app/google-workspace-credentials");
    expect(runner).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(runner).not.toContain("google-workspace-credentials");
    expect(runner).toContain("      - sandbox-control");
    expect(runner).not.toContain("      - sandbox-egress");
    expect(compose).toContain(
      "pgvector/pgvector:pg17@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0",
    );
    expect(compose).toContain(
      "ghcr.io/huggingface/text-embeddings-inference:cpu-1.9@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07",
    );
    expect(compose).toContain("      - intfloat/multilingual-e5-small\n");
    expect(compose).toContain("      - 614241f622f53c4eeff9890bdc4f31cfecc418b3\n");
    // The embedding service's CPU, memory and queue settings are not frozen here as literals:
    // `compose-runtime.test.ts` holds them to the measurement they came from, so a future change
    // has to move them together instead of matching a number nobody can explain.
  });
});

describe("release workflow contract", () => {
  it("tests PR, develop, and main with the exact Compose suite", () => {
    const workflow = readProjectFile(".github/workflows/ci-release.yaml");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("develop");
    expect(workflow).toContain("main");
    expect(workflow).toContain(
      "docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests",
    );
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
    expect(workflow).toContain(
      "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
    );
  });

  it("publishes fixed GHCR names with immutable action revisions and attestations", () => {
    const workflow = readProjectFile(".github/workflows/ci-release.yaml");
    const actionUses = [...workflow.matchAll(/uses:\s+([^\s]+)/g)].map((match) => match[1]);

    expect(actionUses.length).toBeGreaterThan(0);
    for (const action of actionUses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
    for (const image of [
      "osinara-app",
      "osinara-cli-proxy",
      "osinara-sandbox-runtime",
      "osinara-sandbox-runner",
      "osinara-sandbox-egress-proxy",
      "osinara-edge",
    ]) {
      expect(workflow).toContain(`ghcr.io/nyxandro/${image}`);
    }
    expect(workflow.match(/actions\/attest@/g)).toHaveLength(10);
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toMatch(/secrets\.(?!GITHUB_TOKEN)[A-Z0-9_]+/);
  });

  it("requires a new semver and emits the strict digest manifest as release assets", () => {
    const workflow = readProjectFile(".github/workflows/ci-release.yaml");

    expect(workflow).toContain("RELEASE_VERSION_ALREADY_EXISTS");
    expect(workflow).toContain("schemaVersion");
    expect(workflow).toContain("commitSha");
    expect(workflow).toContain("composeSha256");
    expect(workflow).toContain("sha256sum compose.production.yaml");
    expect(workflow).toContain("osinara-deployment.json");
    expect(workflow).toContain("compose.production.yaml");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("RELEASE_NOTES_MISSING");
    expect(workflow).toContain('RELEASE_NOTES_FILE="docs/releases/v${VERSION}.md"');
    expect(workflow).toMatch(/gh release create "\$TAG"[\s\S]*?--notes-file "\$RELEASE_NOTES_FILE"/);
    expect(workflow).toContain('--target "$GITHUB_SHA"');
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("--clobber");
    expect(workflow).toContain("gh release edit");
    expect(workflow).toContain("--draft=false");
    expect(workflow).toContain("--latest");
    expect(workflow).toContain(".immutable == true");
    expect(workflow).not.toContain("git push origin");
    expect(workflow).not.toContain("ssh");
  });

  it("publishes and verifies the standalone installer CLI with its SHA-256 sidecar", () => {
    const workflow = readProjectFile(".github/workflows/ci-release.yaml");
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toContain("build-provider-installer-cli.sh");
    expect(dockerfile).toContain("AS installer-cli-artifact");
    expect(workflow).toContain("--target installer-cli-artifact");
    expect(workflow).toContain('--output "type=local,dest=${ARTIFACT_DIR}"');
    expect(workflow).toContain("osinara-linux-x64");
    expect(workflow).toContain("osinara-linux-x64.sha256");
    expect(workflow).toContain("osinara-installation.tar.gz");
    expect(workflow).toContain("install.sh");
    expect(workflow).toContain("INSTALLATION_ARCHIVE_SHA256");
    expect(workflow).toContain("sha256sum --check osinara-linux-x64.sha256");
    expect(workflow).toMatch(
      /gh release upload[\s\S]*?osinara-linux-x64[\s\S]*?osinara-linux-x64\.sha256/u,
    );
    expect(workflow).toContain(
      '["compose.production.yaml", "install.sh", "osinara-deployment.json", "osinara-installation.tar.gz", "osinara-linux-x64", "osinara-linux-x64.sha256"]',
    );
  });

  // The installer's first graph and every graph an installation host derives later come from one
  // reviewed filter; an inline copy in the workflow could drift from what the controller applies.
  it("builds the installation graph with the controller's own filter", () => {
    const workflow = readProjectFile(".github/workflows/ci-release.yaml");

    expect(workflow).toContain("jq --from-file scripts/production-deploy/installation-compose.jq");
    expect(workflow).not.toContain('del(.services["cli-proxy-api"])');
  });
});

describe("server deployment contract", () => {
  it("loads every controller module in production order without global collisions", () => {
    expect(() => execFileSync("bash", ["-c", [
      "set -euo pipefail",
      "source scripts/production-deploy/common.sh",
      "source scripts/production-deploy/database.sh",
      "source scripts/production-deploy/release.sh",
      "source scripts/production-deploy/backup.sh",
      "source scripts/production-deploy/self-update.sh",
    ].join("; ")], { cwd: projectRoot })).not.toThrow();
  });

  // Each release carries the controller that deploys it: the running controller installs the
  // approved release's copy and hands over before any release rule or service is touched.
  it("hands an approved release to the controller it carries before preparing it", () => {
    const main = readProjectFile("scripts/production-deploy/main.sh");
    const body = main.slice(main.indexOf("main() {"));
    const handover = body.indexOf('ensure_release_controller "$CONTROLLER_ROOT" "$LAUNCHER_PATH"');

    expect(handover).toBeGreaterThan(body.indexOf('download_and_validate_release "$REQUESTED_VERSION"'));
    expect(handover).toBeGreaterThan(body.indexOf("recheck_claim_owner"));
    expect(handover).toBeLessThan(body.indexOf('require_metadata "$AGENT_MODEL_PROVIDER_CONFIG"'));
    expect(handover).toBeLessThan(body.indexOf("\n  prepare_candidate_release\n"));
    expect(body).toContain('"$1" == "--resume"');
    expect(body.indexOf("adopt_claimed_proposal")).toBeLessThan(body.indexOf("claim_approved_proposal"));
    // Every module the controller sources is part of the bootstrap metadata check.
    expect(main).toMatch(/for module in main common database release backup self-update; do/u);
    expect(main).toContain('source "${CONTROLLER_DIR}/self-update.sh"');
    expect(main.lastIndexOf("prune_retired_controllers")).toBeGreaterThan(
      main.lastIndexOf('record_proposal_result "succeeded"'),
    );
  });

  // An older controller starts a newer one through exactly these two forms, so they are frozen
  // across versions: changing either strands the claim an older controller hands over.
  it("keeps the cross-version preflight and resume interface", () => {
    const main = readProjectFile("scripts/production-deploy/main.sh");
    const selfUpdate = readProjectFile("scripts/production-deploy/self-update.sh");
    const body = main.slice(main.indexOf("main() {"));
    const ensure = selfUpdate.slice(selfUpdate.indexOf("ensure_release_controller() {"));

    expect(body).toContain('elif [[ "$#" -eq 3 && "$1" == "--resume" ]]; then');
    expect(body).toContain('elif [[ "$#" -eq 1 && "$1" == "--preflight" ]]; then');
    expect(selfUpdate).toContain('exec "$launcher" --resume "$PROPOSAL_ID" "$LEASE_TOKEN"');
    expect(selfUpdate).toContain('bash "${directory}/main.sh" --preflight');
    // Preflight only checks: it returns before the lock, the claim, or any change.
    const preflightReturn = body.indexOf("return 0", body.indexOf('if [[ "$PREFLIGHT_MODE" -eq 1 ]]'));
    expect(preflightReturn).toBeLessThan(body.indexOf('exec 9>"$LOCK_FILE"'));
    expect(preflightReturn).toBeLessThan(body.indexOf("claim_approved_proposal"));
    // A placed controller is selected only after its own preflight passed.
    expect(ensure.indexOf("install_release_controller")).toBeLessThan(ensure.indexOf("preflight_release_controller"));
    expect(ensure.indexOf("preflight_release_controller")).toBeLessThan(ensure.indexOf("select_release_controller"));
    expect(ensure.indexOf("select_release_controller")).toBeLessThan(ensure.indexOf("hand_over_to_release_controller"));
  });

  // errtrace runs the ERR trap inside every command substitution; without this guard a failing
  // substitution would record the proposal and message the owner twice.
  it("handles a failure once, in the main process only", () => {
    const main = readProjectFile("scripts/production-deploy/main.sh");
    const handler = main.slice(main.indexOf("handle_failure() {"), main.indexOf("handle_signal() {"));
    const guard = handler.indexOf('[[ "$BASHPID" == "$$" ]] || exit "$exit_code"');

    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(handler.indexOf("FAILURE_HANDLING=1"));
    expect(guard).toBeLessThan(handler.indexOf("record_proposal_result"));
  });

  // systemd keeps starting the same fixed path; only the launcher decides which controller runs.
  it("starts the selected controller version through the fixed launcher", () => {
    const launcher = readProjectFile("scripts/production-deploy/launcher.sh");
    const serviceUnit = readProjectFile("infra/systemd/osinara-deploy.service");

    expect(serviceUnit).toContain("ExecStart=/opt/osinara/bin/production-deploy.sh");
    expect(launcher).toContain('readonly LAUNCHER_PATH="/opt/osinara/bin/production-deploy.sh"');
    expect(launcher).toContain('readonly LAUNCHER_CONTROLLER_ROOT="/opt/osinara/bin/controller"');
    expect(launcher).toContain('exec /bin/bash "${controller_dir}/main.sh" "$@"');
  });

  // The agent mounts the operator's model config read-only; every release, initial or update,
  // checks its owner and mode before a candidate is prepared.
  it("checks the mounted model config before preparing a candidate", () => {
    const main = readProjectFile("scripts/production-deploy/main.sh");
    const check = main.indexOf('require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"');

    expect(check).toBeGreaterThan(main.indexOf('download_and_validate_release "$REQUESTED_VERSION"'));
    expect(check).toBeLessThan(main.indexOf("\n  prepare_candidate_release\n"));
    // Two-space indentation: the deployment body itself, not a branch of one mode.
    expect(main).toContain('\n  require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"\n');
  });

  it("is locked, source-independent, digest-strict, and backup-first", () => {
    const { combined: script, files } = readDeployScripts();

    expect(script).toContain("flock -n");
    expect(script).toContain("software_update_proposals");
    expect(script).toContain("fm.role = 'owner'");
    expect(script).toContain("service_completed_successfully");
    expect(script).toContain("ghcr.io/nyxandro/osinara-app@sha256:");
    expect(script).toContain("pg_dump");
    expect(script).toContain("backup_volume");
    expect(script).toContain("preflight_backup");
    expect(script).toContain("prune_old_deploy_backups");
    expect(script).toContain("prune_retired_release_images");
    expect(script).toContain("pg_restore --list");
    expect(script).toContain("tar -tzf");
    expect(script).toContain("restart_current_release");
    expect(script).toContain("127.0.0.1:8082/v1/health");
    expect(script).not.toMatch(/git\s+(pull|fetch|checkout)/);
    expect(script).not.toMatch(/docker\s+(compose\s+)?build/);
    const main = readProjectFile("scripts/production-deploy/main.sh");
    expect(main.indexOf("prune_old_deploy_backups")).toBeGreaterThan(main.indexOf("snapshot_durable_volumes"));
    expect(main.indexOf("pull_release_images")).toBeLessThan(main.indexOf("create_postgres_backup"));
    expect(main.indexOf("prepare_runtime_update")).toBeLessThan(main.indexOf("stop_current_services"));
    expect(main.indexOf("stop_current_services")).toBeLessThan(main.indexOf("create_postgres_backup"));
    expect(main.indexOf("stop_current_services")).toBeLessThan(main.indexOf("snapshot_durable_volumes"));
    expect(main.lastIndexOf("record_proposal_result")).toBeLessThan(
      main.lastIndexOf("prune_retired_release_images"),
    );
    for (const file of files) {
      expect(file.source.split("\n").length, `${file.path} exceeds 500 lines`).toBeLessThanOrEqual(500);
      expect(file.source.startsWith("#!/bin/bash"), `${file.path} has no shell header`).toBe(true);
    }
  });

  it("supports initial deployment and records all terminal proposal states", () => {
    const { combined: script } = readDeployScripts();
    const main = readProjectFile("scripts/production-deploy/main.sh");

    expect(script).toContain("--initial");
    for (const status of ["deploying", "succeeded", "failed", "ambiguous"]) {
      expect(script).toContain(status);
    }
    expect(script).toContain("send_telegram_notification");
    expect(script).toContain("TELEGRAM_BOT_TOKEN");
    expect(script).not.toContain("api.telegram.org/bot${TELEGRAM_BOT_TOKEN}");
    expect(script).toContain("deployment_lease_token");
    expect(script).toContain("deployment_lease_expires_at");
    expect(script).toContain("DEPLOY_STALE_LEASE_AMBIGUOUS");
    expect(script).toContain("trap 'handle_signal SIGTERM' TERM");
    expect(script).toContain("trap 'handle_signal SIGINT' INT");
    expect(main.lastIndexOf('record_proposal_result "succeeded"')).toBeLessThan(
      main.lastIndexOf("send_success_notification"),
    );
    expect(main).toContain("DEPLOY_SUCCESS_NOTIFICATION_FAILED");
  });

  it("binds Compose bytes and validates the resolved root-RCE surface", () => {
    const { combined: script } = readDeployScripts();

    expect(script).toContain("composeSha256");
    expect(script).toContain(".immutable == true");
    expect(script).toContain("sha256sum");
    expect(script).toContain("config --images");
    expect(script).toContain("config --format json");
    expect(script).toContain("DEPLOY_COMPOSE_SERVICE_SET_INVALID");
    expect(script).toContain("DEPLOY_COMPOSE_IMAGE_SET_INVALID");
    expect(script).toContain("DEPLOY_COMPOSE_SECURITY_INVALID");
    expect(script).toContain("privileged");
    expect(script).toContain("network_mode");
    expect(script).toContain("logging.driver");
    expect(script).toContain("/var/run/docker.sock");
    expect(script).toContain("/opt/osinara/agent-model-providers.json");
    expect(script).toContain("osinara-production-cli-proxy-auth");
    expect(script).toContain(".read_only == true");
  });

  it("executes the exact resolved-Compose security predicate fail-closed", () => {
    const valid = resolvedComposeSecurityFixture();
    expect(() => executeComposeSecurityPredicate(valid, "production")).not.toThrow();

    // `volumes_from` must not bypass the exact mount allowlist through another service.
    const inheritedRunnerVolumes = structuredClone(valid) as {
      services: Record<string, { volumes_from?: string[] }>;
    };
    inheritedRunnerVolumes.services.agent!.volumes_from = ["sandbox-runner"];
    expect(() => executeComposeSecurityPredicate(inheritedRunnerVolumes, "production")).toThrow();

    const unsafe = structuredClone(valid) as { services: Record<string, { volumes?: unknown[] }> };
    unsafe.services["telegram-ingress-worker"]!.volumes = [{
      source: "/", target: "/host", type: "bind",
    }];
    expect(() => executeComposeSecurityPredicate(unsafe, "production")).toThrow();

  });

  it("rejects environment image injection, downgrade, and unsafe initial reuse", () => {
    const { combined: script } = readDeployScripts();
    const example = readProjectFile(".env.example");

    expect(example).toContain("DATABASE_URL=\n");
    for (const variable of [
      "OSINARA_APP_IMAGE",
      "SANDBOX_RUNTIME_IMAGE",
      "OSINARA_SANDBOX_RUNNER_IMAGE",
      "OSINARA_SANDBOX_EGRESS_PROXY_IMAGE",
      "OSINARA_EDGE_IMAGE",
    ]) {
      expect(example).not.toContain(`${variable}=`);
      expect(script).toContain(variable);
    }
    expect(script).toContain("DEPLOY_RELEASE_ENV_EXPORTED");
    expect(script).toContain("version_is_greater");
    expect(script).toContain("DEPLOY_DOWNGRADE_FORBIDDEN");
    expect(script).toContain("DEPLOY_INITIAL_STATE_EXISTS");
    expect(script).toContain("com.docker.compose.project=osinara-production");
    expect(script).toContain("mktemp -d");
    expect(script).toContain("promote_candidate_release");
  });

  it("requires exact root ownership and safe pre-migration recovery", () => {
    const { combined: script } = readDeployScripts();

    expect(script).toContain("DEPLOY_PATH_PERMISSIONS_INVALID");
    expect(script).toContain("0:0:600");
    expect(script).toContain("global_owner");
    expect(script).toContain("HAVING count(*) = 1");
    expect(script).toContain("MIGRATION_STARTED");
    expect(script).not.toContain("osinara-production-memory-embedding-model-e5 \\");
  });

  it("installs a persistent root timer without embedding secrets", () => {
    const serviceUnit = readProjectFile("infra/systemd/osinara-deploy.service");
    const timerUnit = readProjectFile("infra/systemd/osinara-deploy.timer");

    expect(serviceUnit).toContain("User=root");
    expect(serviceUnit).toContain("EnvironmentFile=/opt/osinara/.env");
    expect(serviceUnit).toContain("ExecStart=/opt/osinara/bin/production-deploy.sh");
    expect(serviceUnit).toMatch(/TimeoutStartSec=\d+min/);
    expect(timerUnit).toContain("OnUnitActiveSec=1min");
    expect(timerUnit).toContain("Persistent=true");
  });

  it("documents required runtime configuration without release image variables", () => {
    const example = readProjectFile(".env.example");

    expect(example).toContain("DATABASE_URL=\n");
    expect(example).not.toContain("OSINARA_APP_IMAGE=");
  });
});

describe("production edge and installer contract", () => {
  it("publishes attestations for the installer bootstrap and its checksum", () => {
    const workflow = readProjectFile(".github/workflows/ci-release.yaml");

    expect(workflow).toMatch(/Attest installer bootstrap[\s\S]*?subject-path: install\.sh/u);
    expect(workflow).toMatch(/Attest installer checksum[\s\S]*?subject-path: osinara-linux-x64\.sha256/u);
  });

  it("exposes only edge on the dedicated frontend network", () => {
    const compose = readProjectFile("compose.production.yaml");
    const hostOperations = readProjectFile("scripts/provider-installer/production-host-operations.ts");
    const valid = resolvedComposeSecurityFixture();
    const unsafe = structuredClone(valid) as {
      services: Record<string, { networks?: Record<string, null> }>;
    };
    unsafe.services.agent!.networks = { "edge-frontend": null };

    expect(compose.match(/      - edge-frontend/g)).toHaveLength(1);
    expect(compose).toContain("  edge-frontend:\n    name: osinara-production-edge-frontend");
    expect(hostOperations).toContain('"osinara-production-edge-frontend"');
    expect(() => executeComposeSecurityPredicate(valid, "production")).not.toThrow();
    expect(() => executeComposeSecurityPredicate(unsafe, "production")).toThrow();
  });
});
