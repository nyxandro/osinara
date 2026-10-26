/**
 * Deployment manifest validation tests.
 *
 * Constructs covered:
 * - `validate_manifest`: the subscription gateway left on 2026-10-26. The first release without it
 *   still names its old image so the controller already on a server accepts it; later releases do
 *   not name it. Both forms pass, a malformed reference does not, and the approved bytes still bind.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("./", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const digest = (character: string) => character.repeat(64);
const RETIRED_GATEWAY = `ghcr.io/nyxandro/osinara-cli-proxy@sha256:${digest("2")}`;

function manifest(cliProxy: string | null): Record<string, unknown> {
  return {
    commitSha: "a".repeat(40),
    composeSha256: "b".repeat(64),
    images: {
      app: `ghcr.io/nyxandro/osinara-app@sha256:${digest("1")}`,
      ...(cliProxy === null ? {} : { cliProxy }),
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
    STORED_CLI_PROXY=${JSON.stringify(images.cliProxy ?? "")}
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
  it.each([
    ["still names", RETIRED_GATEWAY],
    ["no longer names", null],
  ])("accepts a release that %s the retired gateway image", (_name, cliProxy) => {
    const result = validate(manifest(cliProxy), manifest(cliProxy));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`app=ghcr.io/nyxandro/osinara-app@sha256:${digest("1")}\n`);
  });

  it("refuses a malformed retired gateway reference", () => {
    const published = manifest("ghcr.io/nyxandro/osinara-cli-proxy:latest");

    const result = validate(published, published);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_IMAGE_REFERENCE_INVALID");
  });

  it.each([
    ["the approved manifest named the gateway, the public one does not", RETIRED_GATEWAY, null],
    ["the public manifest names a gateway the approved one did not", null, RETIRED_GATEWAY],
  ])("refuses a release when %s", (_name, approvedGateway, publishedGateway) => {
    const result = validate(manifest(publishedGateway), manifest(approvedGateway));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_APPROVED_MANIFEST_MISMATCH");
  });

  it("refuses an unknown image key", () => {
    const published = manifest(null);
    (published.images as Record<string, string>).extra = `ghcr.io/nyxandro/osinara-app@sha256:${digest("1")}`;

    const result = validate(published, published);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_MANIFEST_INVALID");
  });
});
