/**
 * Release graph tests.
 *
 * Constructs covered:
 * - `release_compose_path`: every host runs the released `compose.production.yaml`; current,
 *   candidate, and promoted paths all go through it.
 * - `set_current_release_paths`: a current release without that file is refused before any change.
 * - `validate_resolved_compose` / `validate_resolved_compose_security`: the release service, image,
 *   and mount set is accepted; an extra service or a host mount is refused.
 * - `compose_declares_volume`, `stop_current_services`, `pull_release_images`: backup and downtime
 *   follow the released graph.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeComposeSecurityPredicate,
  resolvedComposeSecurityFixture,
} from "./production-release-contract-fixtures.js";

const projectRoot = new URL("../", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const MODULES = `
  source scripts/production-deploy/common.sh
  source scripts/production-deploy/release.sh
  source scripts/production-deploy/backup.sh
  log_event() { printf '%s\\n' "$1" >&2; }
  fail() { printf '%s %s\\n' "$1" "$2" >&2; return 1; }
`;
const digest = (character: string) => character.repeat(64);
const IMAGES = `
  APP_IMAGE="ghcr.io/nyxandro/osinara-app@sha256:${digest("1")}"
  EDGE_IMAGE="ghcr.io/nyxandro/osinara-edge@sha256:${digest("3")}"
  EGRESS_IMAGE="ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${digest("4")}"
  RUNNER_IMAGE="ghcr.io/nyxandro/osinara-sandbox-runner@sha256:${digest("5")}"
  RUNTIME_IMAGE="ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:${digest("6")}"
`;

function runShell(source: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${source}`], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** What `docker compose config --format json` reports for a release graph, with its volumes. */
function resolvedCompose(): Record<string, unknown> {
  const services = resolvedComposeSecurityFixture();
  const volumes: Record<string, unknown> = {
    "google-workspace-credentials": { name: "osinara-production-google-workspace-credentials" },
    "memory-embedding-model-e5": { name: "osinara-production-memory-embedding-model-e5" },
    "postgres-data": { name: "osinara-production-postgres-data" },
    "tool-environments": { name: "osinara-production-tool-environments" },
    "workspace-data": { name: "osinara-production-workspace-data" },
  };
  return { name: "osinara-production", ...services, volumes };
}

/** The image list `docker compose config --images` prints for the resolved release graph. */
const RESOLVED_IMAGES = [
  "$APP_IMAGE", "$APP_IMAGE", "$APP_IMAGE", "$APP_IMAGE", "$RUNTIME_IMAGE", "$RUNNER_IMAGE",
  "$EGRESS_IMAGE", "$EDGE_IMAGE", "$POSTGRES_IMAGE", "$TEI_IMAGE",
].join(" ");

function validateResolvedCompose(config: Record<string, unknown> = resolvedCompose(), images = RESOLVED_IMAGES) {
  const directory = temporaryDirectory("osinara-graph-validate-");
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return runShell(`
    ${MODULES}
    ${IMAGES}
    WORK_DIR=${JSON.stringify(directory)}
    compose_candidate() {
      if [[ "$*" == "config --images" ]]; then printf '%s\\n' ${images}; return 0; fi
      if [[ "$*" == "config --format json" ]]; then cat ${JSON.stringify(configPath)}; return 0; fi
      return 2
    }
    validate_resolved_compose
  `);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("release compose path", () => {
  it("names the released YAML of a release directory", () => {
    const result = runShell(`${MODULES}\nrelease_compose_path /opt/osinara/releases/v1.2.3`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("/opt/osinara/releases/v1.2.3/compose.production.yaml\n");
  });

  // A host whose current release lacks the released YAML is refused before anything changes; the
  // preflight of a new controller runs exactly this check.
  it.each([
    ["accepts", true, 0],
    ["refuses", false, 1],
  ])("%s a current release depending on whether it has the released YAML", (_name, withCompose, status) => {
    const base = temporaryDirectory("osinara-graph-host-");
    const release = join(base, "releases", "v1.2.3");
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "release.env"), "", "utf8");
    if (withCompose) writeFileSync(join(release, "compose.production.yaml"), "name: osinara-production\n", "utf8");
    writeFileSync(join(base, "release.env"), "", "utf8");
    symlinkSync(release, join(base, "current"));
    const common = readFileSync(join(projectRoot, "scripts/production-deploy/common.sh"), "utf8")
      .replace('readonly BASE_DIR="/opt/osinara"', `readonly BASE_DIR=${JSON.stringify(base)}`);
    const commonPath = join(base, "common.sh");
    writeFileSync(commonPath, common, "utf8");

    const result = runShell(`
      source ${JSON.stringify(commonPath)}
      fail() { printf '%s %s\\n' "$1" "$2" >&2; return 1; }
      set_current_release_paths
      printf '%s\\n' "$CURRENT_COMPOSE"
    `);

    expect(result.status, result.stderr).toBe(status);
    if (withCompose) expect(result.stdout).toBe(`${base}/current/compose.production.yaml\n`);
    else expect(result.stderr).toContain("DEPLOY_CURRENT_RELEASE_INVALID");
  });

  // Current, candidate, and promoted paths share one helper, so no step can run a file another
  // step never validated.
  it("routes every current and candidate Compose path through one helper", () => {
    const sources = ["common.sh", "release.sh", "backup.sh", "main.sh", "self-update.sh"]
      .map((name) => readFileSync(join(projectRoot, "scripts/production-deploy", name), "utf8"))
      .join("\n");
    const assignments = [...sources.matchAll(/^\s*(CURRENT|CANDIDATE)_COMPOSE=(.+)$/gmu)]
      .map((match) => match[2]!);

    expect(assignments.length).toBeGreaterThanOrEqual(4);
    for (const value of assignments) {
      expect(value).toMatch(/^"(\$\(release_compose_path "\$[A-Z_a-z]+"\)|\$CANDIDATE_COMPOSE)?"$/u);
    }
  });
});

describe("resolved release graph", () => {
  it("accepts the release graph", () => {
    const result = validateResolvedCompose();

    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses a graph with a service the release does not ship", () => {
    const extended = resolvedCompose() as {
      services: Record<string, { depends_on?: Record<string, unknown>; logging?: unknown }>;
    };
    extended.services.agent!.depends_on!["extra-service"] = { condition: "service_healthy", required: true };
    extended.services["extra-service"] = { logging: extended.services.edge!.logging };

    const result = validateResolvedCompose(extended);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_COMPOSE_SERVICE_SET_INVALID");
  });

  it("keeps rejecting host mounts", () => {
    const unsafe = resolvedComposeSecurityFixture() as {
      services: Record<string, { volumes?: unknown[] }>;
    };
    unsafe.services["telegram-ingress-worker"]!.volumes = [{ source: "/", target: "/host", type: "bind" }];

    expect(() => executeComposeSecurityPredicate(unsafe)).toThrow();
  });
});

describe("backup and downtime", () => {
  it("reads volume ownership from the released YAML", () => {
    const directory = temporaryDirectory("osinara-graph-volume-");
    const compose = join(directory, "compose.production.yaml");
    writeFileSync(compose, [
      "name: osinara-production",
      "services: {}",
      "volumes:",
      "  tool-environments:",
      "    name: osinara-production-tool-environments",
      "  workspace-data: {}",
      "",
    ].join("\n"), "utf8");

    const result = runShell(`
      ${MODULES}
      for volume in tool-environments workspace-data postgres-backups; do
        if compose_declares_volume ${JSON.stringify(compose)} "$volume"; then
          printf '%s=declared\\n' "$volume"
        else
          printf '%s=absent\\n' "$volume"
        fi
      done
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("tool-environments=declared\nworkspace-data=declared\npostgres-backups=absent\n");
  });

  it("stops the writers of the release graph", () => {
    const result = runShell(`
      ${MODULES}
      compose_current() { printf '%s\\n' "$*"; }
      stop_current_services
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "stop edge telegram-ingress-worker memory-embedding-worker agent sandbox-runner sandbox-egress-proxy memory-embedding\n",
    );
  });

  it("pulls the release images through the candidate graph", () => {
    const result = runShell(`
      ${MODULES}
      ${IMAGES}
      docker() { printf 'docker %s\\n' "$*"; }
      compose_candidate() { printf 'compose %s\\n' "$*"; }
      pull_release_images
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("osinara-app@sha256");
    expect(result.stdout).toContain("compose pull --quiet");
  });
});
