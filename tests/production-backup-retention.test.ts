/** The last restore point survives every failure until a complete new backup is verified. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
const OLDEST = "20260904T120000Z-to-v0.21.4";
const OLDER = "20260905T120000Z-to-v0.21.5";
const OLD = "20260906T120000Z-to-v0.21.6";
const NEW = "20260907T120000Z-to-v0.21.7";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "osinara-backup-safety-"));
  temporary.push(directory);
  for (const name of [OLDEST, OLDER, OLD]) {
    mkdirSync(join(directory, name));
    writeFileSync(join(directory, name, "postgres.dump"), "previous backup");
  }
  return directory;
}
function shell(source: string) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail
source scripts/production-deploy/backup.sh
fail() { printf '%s\\n' "$1" >&2; return 1; }
log_event() { :; }
${source}`], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
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

it("writes a portable checksum manifest and keeps a step back beyond the newest backup", () => {
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
  // Damage noticed a day or two late needs a copy from before it, not only the newest one.
  expect(readdirSync(directory).sort()).toEqual([OLDER, OLD, NEW, "manual-operator-copy"].sort());
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

// #558: the sandboxes' folders are archived while the bot still answers, the rest after it stopped,
// and the set keeps every archive under one checksum manifest.
it("archives the sandboxes' folders before the stop at the lowest priority and the rest after it", () => {
  const directory = fixture();
  const result = shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
REQUESTED_VERSION=0.21.7
BACKUP_DURABLE_VOLUMES=(osinara-production-google-workspace-credentials osinara-production-tool-environments osinara-production-workspace-data)
backup_volume() { printf '%s %s\\n' "$1" "$2" >> "$BACKUPS_DIR/calls"; printf 'archive' > "$BACKUP_TEMP_DIR/$1.tar.gz"; }
date() { printf '20260907T120000Z'; }
begin_backup
archive_live_volumes
printf 'live done\\n' >> "$BACKUPS_DIR/calls"
printf 'database bytes' > "$BACKUP_TEMP_DIR/postgres.dump"
snapshot_durable_volumes
(cd "$BACKUPS_DIR/${NEW}" && sha256sum --check --status SHA256SUMS)`);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(directory, "calls"), "utf8").trim().split("\n")).toEqual([
    "osinara-production-tool-environments low",
    "osinara-production-workspace-data low",
    "live done",
    "osinara-production-google-workspace-credentials normal",
  ]);
  expect(readdirSync(join(directory, NEW)).sort()).toEqual([
    "SHA256SUMS", "osinara-production-google-workspace-credentials.tar.gz", "osinara-production-tool-environments.tar.gz",
    "osinara-production-workspace-data.tar.gz", "postgres.dump",
  ]);
});

it("runs a live archive and its check at the lowest CPU and disk priority, a stopped one as before", () => {
  const directory = fixture();
  const run = (priority: string, tarExit = 0) => shell(`
BACKUP_TEMP_DIR=${JSON.stringify(directory)}
APP_IMAGE=app@sha256:abc
log_event() { printf 'event %s\\n' "$1" >&2; }
docker() { printf '%s ' "$@"; printf '\\n'; return ${tarExit}; }
nice() { printf 'host-check nice %s\\n' "$*" >&2; }
tar() { printf 'host-check tar %s\\n' "$*" >&2; }
backup_volume volume-a ${priority}`);
  const low = run("low");
  expect(low.status, low.stderr).toBe(0);
  expect(low.stdout).toContain("--entrypoint /usr/bin/nice");
  expect(low.stdout).toContain("-n 19 /usr/bin/ionice -c 3 /bin/tar --warning=no-file-changed --warning=no-file-removed -czf /backup/volume-a.tar.gz -C /data .");
  expect(low.stderr).toContain("host-check nice -n 19 ionice -c 3 tar -tzf");
  const normal = run("normal");
  expect(normal.status, normal.stderr).toBe(0);
  expect(normal.stdout).toContain("--entrypoint /bin/tar");
  expect(normal.stderr).toContain("host-check tar -tzf");
  expect(run("fast").status).not.toBe(0);
  // The bot keeps writing while a live copy reads: GNU tar exits 1 when a file changed or vanished meanwhile.
  const changed = run("low", 1);
  expect(changed.status, changed.stderr).toBe(0);
  expect(changed.stderr).toContain("event DEPLOY_LIVE_ARCHIVE_FILES_CHANGED");
  const broken = run("low", 2);
  expect(broken.status).not.toBe(0);
  expect(broken.stderr).toContain("DEPLOY_LIVE_ARCHIVE_FAILED");
  // A copy taken with the bot stopped has no such excuse.
  expect(run("normal", 1).status).not.toBe(0);
});

it("does not prune in the deployment orchestrator before snapshot completion", () => {
  const source = readFileSync("scripts/production-deploy/main.sh", "utf8");
  expect(source.indexOf("prune_old_deploy_backups")).toBeGreaterThan(source.indexOf("snapshot_durable_volumes"));
});
