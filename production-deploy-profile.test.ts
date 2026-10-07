/**
 * Deployment profile tests.
 *
 * Constructs covered:
 * - `require_deployment_profile`: the host names its graph explicitly; nothing is guessed.
 * - `profile_compose_name`: production runs the released YAML, installation the derived JSON.
 * - `derive_installation_compose`: the shared filter drops exactly the CLIProxy gateway.
 * - `validate_resolved_compose` / `validate_resolved_compose_security`: each profile accepts only
 *   its own service, image, and mount set.
 * - `compose_declares_volume`, `stop_current_services`, `pull_release_images`: backup and
 *   downtime follow the profile's graph.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeComposeSecurityPredicate,
  installationComposeSecurityFixture,
  resolvedComposeSecurityFixture,
} from "./production-release-contract-fixtures.js";

const projectRoot = new URL("./", import.meta.url).pathname;
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
  CLI_PROXY_IMAGE="ghcr.io/nyxandro/osinara-cli-proxy@sha256:${digest("2")}"
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
function resolvedCompose(profile: "installation" | "production"): Record<string, unknown> {
  const services = profile === "production"
    ? resolvedComposeSecurityFixture()
    : installationComposeSecurityFixture();
  const volumes: Record<string, unknown> = {
    "google-workspace-credentials": { name: "osinara-production-google-workspace-credentials" },
    "memory-embedding-model-e5": { name: "osinara-production-memory-embedding-model-e5" },
    "postgres-data": { name: "osinara-production-postgres-data" },
    "tool-environments": { name: "osinara-production-tool-environments" },
    "workspace-data": { name: "osinara-production-workspace-data" },
  };
  if (profile === "production") volumes["cli-proxy-auth"] = { name: "osinara-production-cli-proxy-auth" };
  return { name: "osinara-production", ...services, volumes };
}

/** The image list `docker compose config --images` prints for a profile's resolved graph. */
function resolvedImages(profile: "installation" | "production"): string {
  return [
    "$APP_IMAGE", "$APP_IMAGE", "$APP_IMAGE", "$APP_IMAGE", "$RUNTIME_IMAGE", "$RUNNER_IMAGE",
    "$EGRESS_IMAGE", "$EDGE_IMAGE", "$POSTGRES_IMAGE", "$TEI_IMAGE",
    ...(profile === "production" ? ["$CLI_PROXY_IMAGE"] : []),
  ].join(" ");
}

function validateResolvedCompose(
  hostProfile: "installation" | "production",
  graph: "installation" | "production",
) {
  const directory = temporaryDirectory("osinara-profile-validate-");
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(resolvedCompose(graph)), "utf8");
  return runShell(`
    ${MODULES}
    ${IMAGES}
    DEPLOYMENT_PROFILE=${hostProfile}
    WORK_DIR=${JSON.stringify(directory)}
    compose_candidate() {
      if [[ "$*" == "config --images" ]]; then printf '%s\\n' ${resolvedImages(graph)}; return 0; fi
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

describe("deployment profile selection", () => {
  it.each(["production", "installation"])("accepts the %s profile", (profile) => {
    const result = runShell(`${MODULES}\nrequire_deployment_profile\nprintf '%s\\n' "$DEPLOYMENT_PROFILE"`, {
      OSINARA_DEPLOYMENT_PROFILE: profile,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${profile}\n`);
  });

  it.each([undefined, "", "prod", "installation "])("refuses the profile %j", (profile) => {
    const environment = { ...process.env };
    delete environment.OSINARA_DEPLOYMENT_PROFILE;
    if (profile !== undefined) environment.OSINARA_DEPLOYMENT_PROFILE = profile;
    const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${MODULES}\nrequire_deployment_profile`], {
      cwd: projectRoot,
      encoding: "utf8",
      env: environment,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_PROFILE_INVALID");
  });

  it.each([
    ["production", "compose.production.yaml"],
    ["installation", "compose.installation.json"],
  ])("runs the %s host from %s", (profile, file) => {
    const result = runShell(`${MODULES}\nprofile_compose_name ${profile}`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${file}\n`);
  });
});

describe("release compose path", () => {
  it.each([
    ["production", "/opt/osinara/releases/v1.2.3/compose.production.yaml"],
    ["installation", "/opt/osinara/releases/v1.2.3/compose.installation.json"],
  ])("names the %s graph of a release directory", (profile, path) => {
    const result = runShell(`
      ${MODULES}
      DEPLOYMENT_PROFILE=${profile}
      release_compose_path /opt/osinara/releases/v1.2.3
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${path}\n`);
  });

  // An installation host has no CLI_PROXY_API_KEY: any step that ran the YAML graph there would
  // fail interpolation, so current, candidate, and promoted paths all follow the profile.
  it("routes every current and candidate Compose path through the profile", () => {
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

describe("installation graph", () => {
  it("drops the CLIProxy gateway, its volume, and the agent's wait for it", () => {
    const directory = temporaryDirectory("osinara-profile-derive-");
    const source = join(directory, "compose.production.yaml");
    const target = join(directory, "compose.installation.json");
    const configPath = join(directory, "production-config.json");
    writeFileSync(source, "name: osinara-production\n", "utf8");
    writeFileSync(configPath, JSON.stringify(resolvedCompose("production")), "utf8");

    const result = runShell(`
      ${MODULES}
      CONTROLLER_DIR="$PWD/scripts/production-deploy"
      docker() {
        [[ "$*" == "compose --file ${source} config --no-interpolate --format json" ]] ||
          { printf 'unexpected docker %s\\n' "$*" >&2; return 2; }
        cat ${JSON.stringify(configPath)}
      }
      derive_installation_compose ${JSON.stringify(source)} ${JSON.stringify(target)}
    `);

    expect(result.status, result.stderr).toBe(0);
    const derived = JSON.parse(readFileSync(target, "utf8")) as {
      services: Record<string, { depends_on?: Record<string, unknown> }>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(derived.services)).not.toContain("cli-proxy-api");
    expect(Object.keys(derived.volumes)).not.toContain("cli-proxy-auth");
    expect(Object.keys(derived.services.agent!.depends_on!)).toEqual(["migrate"]);
    expect(Object.keys(derived.services).sort()).toEqual(
      Object.keys(installationComposeSecurityFixture().services as object).sort(),
    );
  });
});

describe("resolved graph per profile", () => {
  it.each(["production", "installation"] as const)("accepts the %s graph on its own host", (profile) => {
    const result = validateResolvedCompose(profile, profile);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["installation", "production"],
    ["production", "installation"],
  ] as const)("refuses on a %s host the %s graph", (hostProfile, graph) => {
    const result = validateResolvedCompose(hostProfile, graph);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DEPLOY_COMPOSE_(IMAGE|SERVICE)_SET_INVALID/u);
  });

  it("accepts the installation mount surface only on an installation host", () => {
    const installation = installationComposeSecurityFixture();

    expect(() => executeComposeSecurityPredicate(installation, "installation")).not.toThrow();
    expect(() => executeComposeSecurityPredicate(installation, "production")).toThrow();
    expect(() => executeComposeSecurityPredicate(resolvedComposeSecurityFixture(), "installation")).toThrow();
  });

  it("keeps rejecting host mounts on an installation host", () => {
    const unsafe = installationComposeSecurityFixture() as {
      services: Record<string, { volumes?: unknown[] }>;
    };
    unsafe.services["telegram-ingress-worker"]!.volumes = [{ source: "/", target: "/host", type: "bind" }];

    expect(() => executeComposeSecurityPredicate(unsafe, "installation")).toThrow();
  });
});

describe("backup and downtime per profile", () => {
  it("reads volume ownership from a JSON installation graph", () => {
    const directory = temporaryDirectory("osinara-profile-volume-");
    const compose = join(directory, "compose.installation.json");
    writeFileSync(compose, JSON.stringify(resolvedCompose("installation")), "utf8");

    const result = runShell(`
      ${MODULES}
      for volume in tool-environments cli-proxy-auth; do
        if compose_declares_volume ${JSON.stringify(compose)} "$volume"; then
          printf '%s=declared\\n' "$volume"
        else
          printf '%s=absent\\n' "$volume"
        fi
      done
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("tool-environments=declared\ncli-proxy-auth=absent\n");
  });

  it.each([
    ["production", "edge telegram-ingress-worker memory-embedding-worker agent cli-proxy-api sandbox-runner sandbox-egress-proxy memory-embedding"],
    ["installation", "edge telegram-ingress-worker memory-embedding-worker agent sandbox-runner sandbox-egress-proxy memory-embedding"],
  ])("stops the writers of the %s graph", (profile, services) => {
    const result = runShell(`
      ${MODULES}
      DEPLOYMENT_PROFILE=${profile}
      compose_current() { printf '%s\\n' "$*"; }
      stop_current_services
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`stop ${services}\n`);
  });

  it.each([
    ["production", true],
    ["installation", false],
  ])("pulls the CLIProxy image on a %s host: %s", (profile, pullsCliProxy) => {
    const result = runShell(`
      ${MODULES}
      ${IMAGES}
      DEPLOYMENT_PROFILE=${profile}
      docker() { printf 'docker %s\\n' "$*"; }
      compose_candidate() { printf 'compose %s\\n' "$*"; }
      pull_release_images
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.includes("osinara-cli-proxy@sha256")).toBe(pullsCliProxy);
    expect(result.stdout).toContain("osinara-app@sha256");
    expect(result.stdout).toContain("compose pull --quiet");
  });
});
