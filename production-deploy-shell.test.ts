/**
 * Production deploy shell policy tests.
 *
 * Constructs covered:
 * - Stable SemVer comparison rejects equal and lower releases.
 * - Exported release image variables fail before Compose interpolation.
 * - `composeSha256` binds the exact released Compose bytes.
 * - PostgreSQL command tags cannot masquerade as returned proposal rows.
 * - Candidate-only volumes are bootstrapped and recovered only before migration starts.
 * - The Eve 0.32 cutover archives and retires only the exact legacy workflow volume.
 * - Backup retention keeps only the new previous-release snapshot after deployment.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("suppresses PostgreSQL command tags for no-row state transitions", () => {
    const databaseScript = readFileSync(
      join(projectRoot, "scripts/production-deploy/database.sh"),
      "utf8",
    );

    expect(databaseScript).toContain("--quiet");
  });

  it("bootstraps a candidate volume only when neither current ownership nor prior bytes exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-candidate-volume-"));
    temporaryDirectories.push(directory);
    const previousComposePath = join(directory, "previous-compose.yaml");
    const currentComposePath = join(directory, "current-compose.yaml");
    const callsPath = join(directory, "docker-calls.log");
    writeFileSync(previousComposePath, "services:\n  agent: {}\n", "utf8");
    writeFileSync(
      currentComposePath,
      "volumes:\n  eve-workflow-data:\n    name: osinara-production-eve-workflow-data-v032\n",
      "utf8",
    );

    const bootstrap = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; exit 1; }
      docker() {
        printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
        [[ "$1 $2" == "volume inspect" ]] && return 1
        [[ "$1 $2" == "volume create" ]] && return 0
        return 2
      }
      CURRENT_COMPOSE=${JSON.stringify(previousComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(currentComposePath)}
      ensure_durable_volume osinara-production-eve-workflow-data-v032 eve-workflow-data
    `);
    const owned = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; exit 1; }
      docker() {
        [[ "$1 $2" == "volume inspect" ]] && return 1
        return 2
      }
      CURRENT_COMPOSE=${JSON.stringify(currentComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(currentComposePath)}
      ensure_durable_volume osinara-production-eve-workflow-data-v032 eve-workflow-data
    `);
    const unownedExisting = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; exit 1; }
      docker() {
        [[ "$1 $2" == "volume inspect" ]] && return 0
        return 2
      }
      CURRENT_COMPOSE=${JSON.stringify(previousComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(currentComposePath)}
      ensure_durable_volume osinara-production-eve-workflow-data-v032 eve-workflow-data
    `);

    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(readFileSync(callsPath, "utf8")).toContain(
      "volume create osinara-production-eve-workflow-data-v032",
    );
    expect(owned.status).toBe(1);
    expect(owned.stderr).toContain("DEPLOY_BACKUP_VOLUME_MISSING");
    expect(unownedExisting.status).toBe(1);
    expect(unownedExisting.stderr).toContain("DEPLOY_CANDIDATE_VOLUME_OWNERSHIP_AMBIGUOUS");
  });

  it("cleans an attempt-created candidate volume and allows the next bootstrap", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-candidate-volume-recovery-"));
    temporaryDirectories.push(directory);
    const previousComposePath = join(directory, "previous-compose.yaml");
    const candidateComposePath = join(directory, "candidate-compose.yaml");
    const callsPath = join(directory, "docker-calls.log");
    writeFileSync(previousComposePath, "services:\n  agent: {}\n", "utf8");
    writeFileSync(candidateComposePath, "volumes:\n  eve-workflow-data: {}\n", "utf8");

    const result = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; return 1; }
      log_event() { printf '%s %s\n' "$1" "$2" >&2; }
      volume_exists=0
      docker() {
        printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
        if [[ "$1 $2" == "volume inspect" ]]; then [[ "$volume_exists" -eq 1 ]]; return; fi
        if [[ "$1 $2" == "volume create" ]]; then volume_exists=1; return 0; fi
        if [[ "$1 $2" == "volume rm" ]]; then volume_exists=0; return 0; fi
        return 2
      }
      CURRENT_COMPOSE=${JSON.stringify(previousComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(candidateComposePath)}
      MIGRATION_STARTED=0
      ensure_durable_volume osinara-production-eve-workflow-data-v032 eve-workflow-data
      cleanup_created_candidate_volumes
      ensure_durable_volume osinara-production-eve-workflow-data-v032 eve-workflow-data
      printf 'tracked=%s exists=%s\n' "\${#CREATED_CANDIDATE_VOLUMES[@]}" "$volume_exists"
    `);

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(callsPath, "utf8");
    expect(calls.match(/volume create osinara-production-eve-workflow-data-v032/g)).toHaveLength(2);
    expect(calls.match(/volume rm osinara-production-eve-workflow-data-v032/g)).toHaveLength(1);
    expect(result.stdout).toContain("tracked=1 exists=1");

    const deployScript = readFileSync(join(projectRoot, "scripts/production-deploy.sh"), "utf8");
    const failureHandler = deployScript.slice(
      deployScript.indexOf("handle_failure()"),
      deployScript.indexOf("handle_signal()"),
    );
    expect(failureHandler.indexOf("cleanup_created_candidate_volumes"))
      .toBeGreaterThan(failureHandler.indexOf("restart_current_release"));
  });

  it("does not clean an attempt-created candidate volume after migration starts", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-candidate-volume-migration-"));
    temporaryDirectories.push(directory);
    const callsPath = join(directory, "docker-calls.log");
    writeFileSync(callsPath, "", "utf8");
    const result = runShell(`
      source scripts/production-deploy/backup.sh
      docker() { printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}; return 0; }
      CREATED_CANDIDATE_VOLUMES=(osinara-production-eve-workflow-data-v032)
      MIGRATION_STARTED=1
      cleanup_created_candidate_volumes
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, "utf8")).not.toContain("volume rm");
  });

  it("fails closed when an attempt-created candidate volume cannot be removed", () => {
    const result = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; return 1; }
      docker() { [[ "$1 $2" == "volume rm" ]] && return 1; return 2; }
      CREATED_CANDIDATE_VOLUMES=(osinara-production-eve-workflow-data-v032)
      MIGRATION_STARTED=0
      cleanup_created_candidate_volumes
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CANDIDATE_VOLUME_CLEANUP_FAILED");
  });

  it("selects the old Eve store for the one-time backup and the new store thereafter", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-eve-volume-cutover-"));
    temporaryDirectories.push(directory);
    const oldComposePath = join(directory, "old-compose.yaml");
    const newComposePath = join(directory, "new-compose.yaml");
    const callsPath = join(directory, "docker-calls.log");
    writeFileSync(
      oldComposePath,
      "volumes:\n  google-workspace-credentials: {}\n  tool-environments: {}\n" +
        "  workflow-data:\n    name: osinara-production-workflow-data\n  workspace-data: {}\n",
      "utf8",
    );
    writeFileSync(
      newComposePath,
      "volumes:\n  google-workspace-credentials: {}\n  tool-environments: {}\n" +
        "  eve-workflow-data:\n    name: osinara-production-eve-workflow-data-v032\n" +
        "  workspace-data: {}\n",
      "utf8",
    );

    const cutover = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; exit 1; }
      docker() {
        printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
        if [[ "$1 $2 $3" == "volume inspect osinara-production-eve-workflow-data-v032" ]]; then return 1; fi
        if [[ "$1 $2" == "volume inspect" ]]; then return 0; fi
        [[ "$1 $2" == "volume create" ]]
      }
      CURRENT_COMPOSE=${JSON.stringify(oldComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(newComposePath)}
      select_durable_volumes
      printf 'backup-count=%s\n' "\${#BACKUP_DURABLE_VOLUMES[@]}"
      printf '%s\n' "\${BACKUP_DURABLE_VOLUMES[@]}"
      printf 'retired=%s\n' "$RETIRED_CUTOVER_VOLUME"
    `);
    const futureDeploy = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; exit 1; }
      docker() {
        [[ "$1 $2" == "volume inspect" ]] && return 0
        return 2
      }
      CURRENT_COMPOSE=${JSON.stringify(newComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(newComposePath)}
      select_durable_volumes
      printf '%s\n' "\${BACKUP_DURABLE_VOLUMES[@]}"
    `);

    expect(cutover.status, cutover.stderr).toBe(0);
    expect(cutover.stdout).toContain("backup-count=4");
    expect(cutover.stdout).toContain("osinara-production-workflow-data");
    expect(cutover.stdout).not.toContain("osinara-production-eve-workflow-data-v032");
    expect(cutover.stdout).toContain("retired=osinara-production-workflow-data");
    expect(readFileSync(callsPath, "utf8")).toContain(
      "volume create osinara-production-eve-workflow-data-v032",
    );
    expect(futureDeploy.status, futureDeploy.stderr).toBe(0);
    expect(futureDeploy.stdout).toContain("osinara-production-eve-workflow-data-v032");
    expect(futureDeploy.stdout).not.toContain("osinara-production-workflow-data");
  });

  it("archives and preserves the v0.32 local world during PostgreSQL cutover", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-postgres-world-cutover-"));
    temporaryDirectories.push(directory);
    const currentComposePath = join(directory, "current-compose.yaml");
    const candidateComposePath = join(directory, "candidate-compose.yaml");
    writeFileSync(
      currentComposePath,
      "volumes:\n  eve-workflow-data:\n    name: osinara-production-eve-workflow-data-v032\n",
      "utf8",
    );
    writeFileSync(candidateComposePath, "services:\n  agent: {}\n", "utf8");

    const result = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; exit 1; }
      docker() {
        [[ "$1 $2" == "volume inspect" ]] && return 0
        return 2
      }
      CURRENT_COMPOSE=${JSON.stringify(currentComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(candidateComposePath)}
      select_durable_volumes
      printf 'preserved=%s\n' "$PRESERVED_WORKFLOW_CUTOVER_VOLUME"
      printf '%s\n' "\${BACKUP_DURABLE_VOLUMES[@]}"
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "preserved=osinara-production-eve-workflow-data-v032",
    );
    expect(result.stdout).toContain("osinara-production-eve-workflow-data-v032");
    expect(result.stdout).not.toContain("volume rm");
  });

  it("forbids removal of a current-owned durable volume outside the Eve cutover", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-durable-volume-removal-"));
    temporaryDirectories.push(directory);
    const currentComposePath = join(directory, "current-compose.yaml");
    const candidateComposePath = join(directory, "candidate-compose.yaml");
    writeFileSync(currentComposePath, "volumes:\n  workspace-data: {}\n", "utf8");
    writeFileSync(candidateComposePath, "volumes:\n  eve-workflow-data: {}\n", "utf8");

    const result = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; exit 1; }
      docker() {
        if [[ "$1 $2 $3" == "volume inspect osinara-production-eve-workflow-data-v032" ]]; then
          return 1
        fi
        [[ "$1 $2" == "volume inspect" ]] && return 0
        [[ "$1 $2" == "volume create" ]]
      }
      CURRENT_COMPOSE=${JSON.stringify(currentComposePath)}
      CANDIDATE_COMPOSE=${JSON.stringify(candidateComposePath)}
      select_durable_volumes
    `);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEPLOY_CANDIDATE_DURABLE_VOLUME_REMOVED");
  });

  it("retires the exact archived legacy Eve volume only after candidate health", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-retired-eve-volume-"));
    temporaryDirectories.push(directory);
    const callsPath = join(directory, "docker-calls.log");
    const early = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; return 1; }
      docker() { printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}; return 0; }
      RETIRED_CUTOVER_VOLUME=osinara-production-workflow-data
      RETIRED_CUTOVER_ARCHIVED=1
      CANDIDATE_HEALTH_VALIDATED=0
      remove_retired_cutover_volume
    `);
    const successful = runShell(`
      source scripts/production-deploy/backup.sh
      log_event() { printf '%s %s\n' "$1" "$2" >&2; }
      docker() { printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}; return 0; }
      RETIRED_CUTOVER_VOLUME=osinara-production-workflow-data
      RETIRED_CUTOVER_ARCHIVED=1
      CANDIDATE_HEALTH_VALIDATED=1
      remove_retired_cutover_volume
    `);
    const failedRemoval = runShell(`
      source scripts/production-deploy/backup.sh
      fail() { printf '%s %s\n' "$1" "$2" >&2; return 1; }
      docker() { return 1; }
      RETIRED_CUTOVER_VOLUME=osinara-production-workflow-data
      RETIRED_CUTOVER_ARCHIVED=1
      CANDIDATE_HEALTH_VALIDATED=1
      remove_retired_cutover_volume
    `);

    expect(early.status).toBe(1);
    expect(early.stderr).toContain("DEPLOY_RETIRED_VOLUME_BOUNDARY_INVALID");
    expect(successful.status, successful.stderr).toBe(0);
    expect(failedRemoval.status).toBe(1);
    expect(failedRemoval.stderr).toContain("DEPLOY_RETIRED_VOLUME_REMOVAL_FAILED");
    const calls = readFileSync(callsPath, "utf8");
    expect(calls.match(/volume rm osinara-production-workflow-data/g)).toHaveLength(1);
    expect(calls).not.toContain("volume rm osinara-production-eve-workflow-data-v032");
  });

  it("retires the legacy volume after promotion and before terminal success", () => {
    const deployScript = readFileSync(join(projectRoot, "scripts/production-deploy.sh"), "utf8");
    const migration = deployScript.indexOf("MIGRATION_STARTED=1");
    const health = deployScript.indexOf("wait_for_health", migration);
    const promote = deployScript.indexOf("promote_candidate_release", health);
    const retire = deployScript.indexOf("remove_retired_cutover_volume", promote);
    const terminal = deployScript.indexOf('record_proposal_result "succeeded"', retire);

    expect(health).toBeGreaterThan(migration);
    expect(promote).toBeGreaterThan(health);
    expect(retire).toBeGreaterThan(promote);
    expect(terminal).toBeGreaterThan(retire);
    expect(deployScript).toContain('if [[ "$MIGRATION_STARTED" -eq 1 ]]; then\n    status="ambiguous"');
  });

  it("removes only non-retained Osinara release image references", () => {
    const directory = mkdtempSync(join(tmpdir(), "osinara-image-retention-"));
    temporaryDirectories.push(directory);
    const callsPath = join(directory, "docker-calls.log");
    for (const [version, digest] of [
      ["v0.2.8", "a".repeat(64)],
      ["v0.2.9", "b".repeat(64)],
      ["v0.2.10", "c".repeat(64)],
    ]) {
      const releaseDirectory = join(directory, version);
      mkdirSync(releaseDirectory);
      writeFileSync(
        join(releaseDirectory, "release.env"),
        `OSINARA_APP_IMAGE=ghcr.io/nyxandro/osinara-app@sha256:${digest}\n`,
        "utf8",
      );
    }

    const result = runShell(`
      RELEASES_DIR=${JSON.stringify(directory)}
      RELEASE_IMAGE_VARIABLES=(OSINARA_APP_IMAGE)
      source scripts/production-deploy/release.sh
      log_event() { printf '%s %s\n' "$1" "$2" >&2; }
      docker() {
        printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
        [[ "$1 $2" == "image inspect" || "$1 $2" == "image rm" ]]
      }
      prune_retired_release_images
    `);

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(callsPath, "utf8");
    expect(calls).toContain(`image rm ghcr.io/nyxandro/osinara-app@sha256:${"a".repeat(64)}`);
    expect(calls).not.toContain(`image rm ghcr.io/nyxandro/osinara-app@sha256:${"b".repeat(64)}`);
    expect(calls).not.toContain(`image rm ghcr.io/nyxandro/osinara-app@sha256:${"c".repeat(64)}`);
    expect(readdirSync(directory).filter((name) => name.startsWith("v")).sort())
      .toEqual(["v0.2.10", "v0.2.9"]);
  });
});
