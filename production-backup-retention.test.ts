/** The last restore point survives every failure until a complete new backup is verified. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
const OLD = "20260906T120000Z-to-v0.21.6";
const NEW = "20260907T120000Z-to-v0.21.7";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "osinara-backup-safety-"));
  temporary.push(directory);
  mkdirSync(join(directory, OLD));
  writeFileSync(join(directory, OLD, "postgres.dump"), "previous backup");
  return directory;
}
function shell(source: string) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail
source scripts/production-deploy/backup.sh
fail() { printf '%s\\n' "$1" >&2; return 1; }
log_event() { :; }
${source}`], { cwd: new URL("./", import.meta.url), encoding: "utf8" });
}
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("does not prune before a new verified snapshot exists", () => {
  const directory = fixture();
  const result = shell(`BACKUPS_DIR=${JSON.stringify(directory)}; prune_old_deploy_backups`);
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(directory, OLD, "postgres.dump"), "utf8")).toBe("previous backup");
});

it("retains old backups when creating any archive fails", () => {
  const directory = fixture();
  const result = shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
BACKUP_TEMP_DIR="$(mktemp -d "$BACKUPS_DIR/.backup.XXXXXX")"
BACKUP_DURABLE_VOLUMES=(first second)
backup_volume() { [[ "$1" == first ]]; }
snapshot_durable_volumes
prune_old_deploy_backups`);
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(directory, OLD, "postgres.dump"), "utf8")).toBe("previous backup");
});

it("writes a portable checksum manifest and keeps only the newly verified rolling backup", () => {
  const directory = fixture();
  mkdirSync(join(directory, "manual-operator-copy"));
  const result = shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
REQUESTED_VERSION=0.21.7
BACKUP_TEMP_DIR="$(mktemp -d "$BACKUPS_DIR/.backup.XXXXXX")"
printf 'database bytes' > "$BACKUP_TEMP_DIR/postgres.dump"
BACKUP_DURABLE_VOLUMES=(workspace)
backup_volume() { printf 'archive bytes' > "$BACKUP_TEMP_DIR/$1.tar.gz"; }
date() { printf '20260907T120000Z'; }
snapshot_durable_volumes
(cd "$BACKUPS_DIR/${NEW}" && sha256sum --check SHA256SUMS)
prune_old_deploy_backups`);
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(directory).sort()).toEqual([NEW, "manual-operator-copy"].sort());
  expect(readFileSync(join(directory, NEW, "SHA256SUMS"), "utf8")).not.toContain(directory);
});

it("refuses to delete the old backup when the new snapshot is corrupted", () => {
  const directory = fixture();
  const result = shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
REQUESTED_VERSION=0.21.7
BACKUP_TEMP_DIR="$(mktemp -d "$BACKUPS_DIR/.backup.XXXXXX")"
printf 'database bytes' > "$BACKUP_TEMP_DIR/postgres.dump"
BACKUP_DURABLE_VOLUMES=(workspace)
backup_volume() { printf 'archive bytes' > "$BACKUP_TEMP_DIR/$1.tar.gz"; }
date() { printf '20260907T120000Z'; }
snapshot_durable_volumes
printf 'corrupted' > "$BACKUPS_DIR/${NEW}/postgres.dump"
prune_old_deploy_backups`);
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(directory, OLD, "postgres.dump"), "utf8")).toBe("previous backup");
});

it("does not prune in the deployment orchestrator before snapshot completion", () => {
  const source = readFileSync("scripts/production-deploy.sh", "utf8");
  expect(source.indexOf("prune_old_deploy_backups")).toBeGreaterThan(source.indexOf("snapshot_durable_volumes"));
});
