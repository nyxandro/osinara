/**
 * Deployment manifest validation tests.
 *
 * Constructs covered:
 * - `validate_manifest`: a release names exactly its five images; any other image key is refused,
 *   and the approved bytes still bind.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const digest = (character: string) => character.repeat(64);

function manifest(): Record<string, unknown> {
  return {
    commitSha: "a".repeat(40),
    composeSha256: "b".repeat(64),
    images: {
      app: `ghcr.io/nyxandro/osinara-app@sha256:${digest("1")}`,
      edge: `ghcr.io/nyxandro/osinara-edge@sha256:${digest("3")}`,
      sandboxEgressProxy: `ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:${digest("4")}`,
      sandboxRunner: `ghcr.io/nyxandro/osinara-sandbox-runner@sha256:${digest("5")}`,
      sandboxRuntime: `ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:${digest("6")}`,
    },
    schemaVersion: 1,
    version: "1.2.3",
  };
}

/** Runs `validate_manifest` the way a claimed upgrade does, with the approved bytes as stored. */
function validate(published: Record<string, unknown>, approved: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "osinara-manifest-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "osinara-deployment.json");
  writeFileSync(path, JSON.stringify(published), "utf8");
  const images = approved.images as Record<string, string | undefined>;
  return spawnSync("/bin/bash", ["-c", `
    set -euo pipefail
    source scripts/production-deploy/common.sh
    source scripts/production-deploy/release.sh
    log_event() { :; }
    fail() { printf '%s %s\\n' "$1" "$2" >&2; return 1; }
    INITIAL_MODE=0
    STORED_VERSION=${JSON.stringify(approved.version)}
    STORED_COMMIT=${JSON.stringify(approved.commitSha)}
    STORED_COMPOSE_SHA=${JSON.stringify(approved.composeSha256)}
    STORED_APP=${JSON.stringify(images.app)}
    STORED_EDGE=${JSON.stringify(images.edge)}
    STORED_EGRESS=${JSON.stringify(images.sandboxEgressProxy)}
    STORED_RUNNER=${JSON.stringify(images.sandboxRunner)}
    STORED_RUNTIME=${JSON.stringify(images.sandboxRuntime)}
    validate_manifest ${JSON.stringify(path)} 1.2.3
    printf 'app=%s\\n' "$APP_IMAGE"
  `], { cwd: projectRoot, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("deployment manifest validation", () => {
  it("accepts a release that names its five images", () => {
    const result = validate(manifest(), manifest());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`app=ghcr.io/nyxandro/osinara-app@sha256:${digest("1")}\n`);
  });

  it("refuses an unknown image key", () => {
    const published = manifest();
    (published.images as Record<string, string>).extra = `ghcr.io/nyxandro/osinara-app@sha256:${digest("1")}`;

    const result = validate(published, published);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_MANIFEST_INVALID");
  });

  it("refuses a release whose public manifest differs from the approved bytes", () => {
    const approved = manifest();
    const published = manifest();
    (published.images as Record<string, string>).edge = `ghcr.io/nyxandro/osinara-edge@sha256:${digest("7")}`;

    const result = validate(published, approved);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_APPROVED_MANIFEST_MISMATCH");
  });
});
