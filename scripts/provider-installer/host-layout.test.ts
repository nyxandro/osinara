/**
 * Installed host layout tests.
 *
 * Constructs covered:
 * - `resolveCurrentRelease`: operator commands follow `current` into one release directory and
 *   refuse a link that points anywhere else.
 * - The installer's paths are the release controller's: a drift would silently break the shared
 *   lock, the profile, or where either side looks for the current release.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTROLLER_ROOT,
  CURRENT_LINK,
  DEPLOY_LOCK_PATH,
  DEPLOYMENT_PROFILE,
  ENV_PATH,
  INSTALLATION_COMPOSE_NAME,
  LAUNCHER_PATH,
  MODEL_CONFIG_PATH,
  RELEASE_ENV_PATH,
  RELEASES_DIR,
  resolveCurrentRelease,
} from "./host-layout.js";

const projectRoot = new URL("../../", import.meta.url).pathname;

const temporaryDirectories: string[] = [];

function base(): { currentLink: string; releasesDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "osinara-host-layout-"));
  temporaryDirectories.push(root);
  const releasesDir = join(root, "releases");
  mkdirSync(join(releasesDir, "v0.41.0"), { recursive: true });
  return { currentLink: join(root, "current"), releasesDir, root };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("current release resolution", () => {
  it("returns the files of the release that current selects", async () => {
    const { currentLink, releasesDir } = base();
    symlinkSync(join(releasesDir, "v0.41.0"), currentLink);

    await expect(resolveCurrentRelease(currentLink, releasesDir)).resolves.toEqual({
      composePath: join(releasesDir, "v0.41.0", "compose.installation.json"),
      directory: join(releasesDir, "v0.41.0"),
      manifestPath: join(releasesDir, "v0.41.0", "osinara-deployment.json"),
      releaseEnvPath: join(releasesDir, "v0.41.0", "release.env"),
    });
  });

  it.each([
    ["a plain directory", ({ currentLink }: ReturnType<typeof base>) => mkdirSync(currentLink)],
    ["a target outside the releases directory", ({ currentLink, root }: ReturnType<typeof base>) => {
      mkdirSync(join(root, "v0.41.0"));
      symlinkSync(join(root, "v0.41.0"), currentLink);
    }],
    ["a target that is no release version", ({ currentLink, releasesDir }: ReturnType<typeof base>) => {
      mkdirSync(join(releasesDir, "latest"));
      symlinkSync(join(releasesDir, "latest"), currentLink);
    }],
    ["no link at all", () => undefined],
  ])("refuses %s", async (_case, arrange) => {
    const host = base();
    arrange(host);

    await expect(resolveCurrentRelease(host.currentLink, host.releasesDir)).rejects.toMatchObject({
      code: "OSINARA_OPERATION_RELEASE_INVALID",
    });
  });
});

describe("layout shared with the release controller", () => {
  it("uses the controller's own paths, lock, and installation graph", () => {
    const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail
      source scripts/production-deploy/common.sh
      DEPLOYMENT_PROFILE=${DEPLOYMENT_PROFILE}
      printf '%s\\n' "$LOCK_FILE" "$LAUNCHER_PATH" "$CONTROLLER_ROOT" "$CURRENT_LINK" \\
        "$GLOBAL_RELEASE_ENV" "$RELEASES_DIR" "$SERVER_ENV" "$AGENT_MODEL_PROVIDER_CONFIG" \\
        "$(release_compose_path /release)"
    `], { cwd: projectRoot, encoding: "utf8" });
    const launcher = spawnSync("/bin/bash", ["-c", `
      source scripts/production-deploy/launcher.sh
      printf '%s\\n' "$LAUNCHER_PATH" "$LAUNCHER_CONTROLLER_ROOT"
    `], { cwd: projectRoot, encoding: "utf8" });
    const unit = readFileSync(join(projectRoot, "infra/systemd/osinara-deploy.service"), "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      DEPLOY_LOCK_PATH,
      LAUNCHER_PATH,
      CONTROLLER_ROOT,
      CURRENT_LINK,
      RELEASE_ENV_PATH,
      RELEASES_DIR,
      ENV_PATH,
      MODEL_CONFIG_PATH,
      `/release/${INSTALLATION_COMPOSE_NAME}`,
    ]);
    expect(launcher.stdout.trim().split("\n")).toEqual([LAUNCHER_PATH, CONTROLLER_ROOT]);
    expect(unit).toContain(`ExecStart=${LAUNCHER_PATH}\n`);
    expect(unit).toContain(`EnvironmentFile=${ENV_PATH}\n`);
  });
});
