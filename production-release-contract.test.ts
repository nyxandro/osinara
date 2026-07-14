/**
 * Production release and deployment contract tests.
 *
 * Constructs covered:
 * - Container-only first-party Docker targets and OCI provenance labels.
 * - Digest-only production Compose wiring, migration ordering, and isolation boundaries.
 * - Main-only GHCR release workflow with pinned actions and artifact attestations.
 * - Server-only deployment locking, validation, backup, status, and notification flow.
 * - Root-owned systemd polling units and required production environment documentation.
 */
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url);

function readProjectFile(path: string): string {
  return readFileSync(new URL(path, projectRoot), "utf8");
}

function readDeployScripts(): { combined: string; files: Array<{ path: string; source: string }> } {
  const moduleDirectory = new URL("scripts/production-deploy/", projectRoot);
  const paths = [
    "scripts/production-deploy.sh",
    ...readdirSync(moduleDirectory)
      .filter((name) => name.endsWith(".sh"))
      .sort()
      .map((name) => `scripts/production-deploy/${name}`),
  ];
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

    // Eve 0.22.5 serves built output but still bundles authored modules during `eve start`.
    const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime"));
    expect(runtime).toContain("COPY --from=build /app/.runtime ./.runtime");
    expect(runtime).toContain("COPY --from=build /app/agent ./agent");
    expect(runtime).not.toMatch(/COPY --from=build \/app\/(scripts|services)\b/);
    expect(entrypoint).toContain("node .runtime/scripts/migrate.js");
    expect(entrypoint).toContain("node .runtime/scripts/validate-model-provider-config.js");
    expect(entrypoint).not.toContain("npm run migrate");
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

  it("gates the agent on migration and keeps stable state and ingress", () => {
    const compose = readProjectFile("compose.production.yaml");
    const agent = service(compose, "agent", "migrate");
    const migrate = service(compose, "migrate", "memory-embedding-worker");
    const edge = service(compose, "edge", "sandbox-runtime-image");

    expect(agent).toContain("migrate:\n        condition: service_completed_successfully");
    expect(agent).toContain('command: ["start-after-migration"]');
    expect(migrate).toContain("restart: \"no\"");
    expect(migrate).toContain(".runtime/scripts/migrate.js");
    expect(agent).toContain("healthcheck:");
    expect(edge).toContain("healthcheck:");
    expect(edge).toContain('"127.0.0.1:8082:80"');

    for (const volume of [
      "postgres-data",
      "memory-embedding-model-e5",
      "sandbox-data",
      "tool-environments",
      "workflow-data",
      "workspace-data",
    ]) {
      expect(compose).toMatch(
        new RegExp(`  ${volume}:\\n    name: osinara-production-${volume}\\n`),
      );
    }
    for (const network of ["app-network", "sandbox-control", "sandbox-egress"]) {
      expect(compose).toMatch(
        new RegExp(`  ${network}:\\n(?:    internal: true\\n)?    name: osinara-production-${network}\\n`),
      );
    }
  });

  it("limits Docker control to the runner and tunes pinned TEI for one CPU", () => {
    const compose = readProjectFile("compose.production.yaml");
    const agent = service(compose, "agent", "migrate");
    const runner = service(compose, "sandbox-runner", "sandbox-egress-proxy");

    expect(compose.match(/\/var\/run\/docker\.sock/g)).toHaveLength(2);
    expect(agent).not.toContain("/var/run/docker.sock");
    expect(runner).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(runner).toContain("      - sandbox-control");
    expect(runner).not.toContain("      - sandbox-egress");
    expect(compose).toContain(
      "pgvector/pgvector:pg17@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0",
    );
    expect(compose).toContain(
      "ghcr.io/huggingface/text-embeddings-inference:cpu-1.9@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07",
    );
    expect(compose).toContain("    cpus: 1.0\n");
    expect(compose).toContain('      OMP_NUM_THREADS: "1"\n');
    expect(compose).toContain('      - "1"\n      - --max-client-batch-size');
    expect(compose).toContain("      - intfloat/multilingual-e5-small\n");
    expect(compose).toContain("      - 614241f622f53c4eeff9890bdc4f31cfecc418b3\n");
  });
});

describe("release workflow contract", () => {
  it("tests PR, develop, and main with the exact Compose suite", () => {
    const workflow = readProjectFile(".github/workflows/ci-release.yaml");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("develop");
    expect(workflow).toContain("main");
    expect(workflow).toContain(
      "docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests",
    );
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
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
    expect(workflow.match(/actions\/attest@/g)).toHaveLength(6);
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
});

describe("server deployment contract", () => {
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
    expect(script).toContain("pg_restore --list");
    expect(script).toContain("tar -tzf");
    expect(script).toContain("restart_current_release");
    expect(script).toContain("127.0.0.1:8082/eve/v1/health");
    expect(script).not.toMatch(/git\s+(pull|fetch|checkout)/);
    expect(script).not.toMatch(/docker\s+(compose\s+)?build/);
    const main = readProjectFile("scripts/production-deploy.sh");
    expect(main.indexOf("pull_release_images")).toBeLessThan(main.indexOf("create_postgres_backup"));
    expect(main.indexOf("create_postgres_backup")).toBeLessThan(main.indexOf("stop_current_services"));
    expect(main.indexOf("stop_current_services")).toBeLessThan(main.indexOf("snapshot_durable_volumes"));
    for (const file of files) {
      expect(file.source.split("\n").length, `${file.path} exceeds 500 lines`).toBeLessThanOrEqual(500);
      expect(file.source.startsWith("#!/bin/bash"), `${file.path} has no shell header`).toBe(true);
    }
  });

  it("supports initial deployment and records all terminal proposal states", () => {
    const { combined: script } = readDeployScripts();
    const main = readProjectFile("scripts/production-deploy.sh");

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
    expect(script).toContain("/var/run/docker.sock");
    expect(script).toContain("/opt/osinara/model-providers.json");
    expect(script).toContain(".read_only == true");
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
    expect(script).not.toContain("osinara-production-sandbox-data \\");
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
