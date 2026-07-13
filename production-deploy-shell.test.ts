/**
 * Production deploy shell policy tests.
 *
 * Constructs covered:
 * - Stable SemVer comparison rejects equal and lower releases.
 * - Exported release image variables fail before Compose interpolation.
 * - `composeSha256` binds the exact released Compose bytes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

function runShell(source: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${source}`], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("production deploy shell policies", () => {
  it.each([
    ["1.10.0", "1.9.9", 0],
    ["2.0.0", "1.99.99", 0],
    ["1.2.3", "1.2.3", 1],
    ["1.2.2", "1.2.3", 1],
  ])("compares candidate %s to current %s", (candidate, current, expectedStatus) => {
    const result = runShell(`
      source scripts/production-deploy/common.sh
      version_is_greater ${candidate} ${current}
    `);

    expect(result.status, result.stderr).toBe(expectedStatus);
  });

  it("rejects a release image exported by the server environment", () => {
    const result = runShell(`
      source scripts/production-deploy/common.sh
      log_event() { printf '%s\\n' "$1" >&2; }
      require_release_environment_clean
    `, { OSINARA_APP_IMAGE: "attacker-controlled" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_RELEASE_ENV_EXPORTED");
  });

  it("accepts only Compose bytes matching composeSha256", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-compose-hash-"));
    temporaryDirectories.push(directory);
    const composePath = join(directory, "compose.production.yaml");
    writeFileSync(composePath, "name: osinara-production\n", "utf8");
    const valid = runShell(`
      source scripts/production-deploy/common.sh
      source scripts/production-deploy/release.sh
      MANIFEST_COMPOSE_SHA="$(sha256sum '${composePath}' | cut -d ' ' -f1)"
      verify_compose_hash '${composePath}'
    `);
    const invalid = runShell(`
      source scripts/production-deploy/common.sh
      source scripts/production-deploy/release.sh
      log_event() { printf '%s\\n' "$1" >&2; }
      MANIFEST_COMPOSE_SHA="${"a".repeat(64)}"
      verify_compose_hash '${composePath}'
    `);

    expect(valid.status, valid.stderr).toBe(0);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("DEPLOY_COMPOSE_HASH_MISMATCH");
  });
});
