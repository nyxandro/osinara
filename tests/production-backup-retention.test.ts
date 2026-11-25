/** The last restore point survives every failure until a complete new backup is verified. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const temporary: string[] = [];
const OLDEST = "20260904T120000Z-to-v0.21.4";
const OLDER = "20260905T120000Z-to-v0.21.5";
const OLD = "20260906T120000Z-to-v0.21.6";
const NEW = "20260907T120000Z-to-v0.21.7";
const TOOLS = "osinara-production-tool-environments";
const WORKSPACES = "osinara-production-workspace-data";
const GOOGLE = "osinara-production-google-workspace-credentials";
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
source scripts/production-deploy/live-copy.sh
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
prune_old_deploy_backups
ls -A "$BACKUPS_DIR" > "$BACKUPS_DIR/../during-stop"
remove_retired_deploy_backups`);
  expect(result.status, result.stderr).toBe(0);
  // #577: during the stop the oldest set is only renamed out of the rotation; its files go afterwards.
  expect(readFileSync(join(directory, "..", "during-stop"), "utf8").trim().split("\n").sort()).toEqual(
    [`.retired.${OLDEST}`, OLDER, OLD, NEW, "manual-operator-copy"].sort(),
  );
  // Damage noticed a day or two late needs a copy from before it, not only the newest one.
  expect(readdirSync(directory).sort()).toEqual([OLDER, OLD, NEW, "manual-operator-copy"].sort());
  expect(readFileSync(join(directory, NEW, "SHA256SUMS"), "utf8")).not.toContain(directory);
});

it("deletes sets an interrupted deploy retired and refuses to delete anything else by that name", () => {
  const directory = fixture();
  mkdirSync(join(directory, `.retired.${OLDEST}`, "osinara-production-tool-environments", "chat"), { recursive: true });
  writeFileSync(join(directory, `.retired.${OLDEST}`, "postgres.dump"), "retired");
  const removed = shell(`BACKUPS_DIR=${JSON.stringify(directory)}; remove_retired_deploy_backups`);
  expect(removed.status, removed.stderr).toBe(0);
  expect(readdirSync(directory).sort()).toEqual([OLDEST, OLDER, OLD].sort());
  writeFileSync(join(directory, ".retired.stray-file"), "not a set");
  const refused = shell(`BACKUPS_DIR=${JSON.stringify(directory)}; remove_retired_deploy_backups`);
  expect(refused.status).not.toBe(0);
  expect(readFileSync(join(directory, ".retired.stray-file"), "utf8")).toBe("not a set");
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

// #558, #577: the sandboxes' folders are copied while the bot still answers, the rest after it stopped.
// The checksum manifest covers the files made with the bot stopped; rsync checks every copied file itself.
it("copies the sandboxes' folders before the stop and sums only the files taken after it", () => {
  const directory = fixture();
  const result = shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
REQUESTED_VERSION=0.21.7
BACKUP_DURABLE_VOLUMES=(${GOOGLE} ${TOOLS} ${WORKSPACES})
copy_live_volume() { printf 'live %s\\n' "$1" >> "$BACKUPS_DIR/calls"; mkdir -p "$BACKUP_TEMP_DIR/$1/chat"; printf 'file' > "$BACKUP_TEMP_DIR/$1/chat/notes.txt"; }
backup_volume() { printf 'stopped %s\\n' "$1" >> "$BACKUPS_DIR/calls"; printf 'archive' > "$BACKUP_TEMP_DIR/$1.tar.gz"; }
date() { printf '20260907T120000Z'; }
begin_backup
copy_live_volumes
printf 'live done\\n' >> "$BACKUPS_DIR/calls"
printf 'database bytes' > "$BACKUP_TEMP_DIR/postgres.dump"
snapshot_durable_volumes
(cd "$BACKUPS_DIR/${NEW}" && sha256sum --check --status SHA256SUMS)
prune_old_deploy_backups`);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(directory, "calls"), "utf8").trim().split("\n")).toEqual([
    `live ${TOOLS}`,
    `live ${WORKSPACES}`,
    "live done",
    `stopped ${GOOGLE}`,
  ]);
  expect(readdirSync(join(directory, NEW)).sort()).toEqual(
    ["SHA256SUMS", `${GOOGLE}.tar.gz`, TOOLS, WORKSPACES, "postgres.dump"].sort(),
  );
  const sums = readFileSync(join(directory, NEW, "SHA256SUMS"), "utf8");
  expect(sums).toContain("./postgres.dump");
  expect(sums).toContain(`./${GOOGLE}.tar.gz`);
  expect(sums).not.toContain("notes.txt");
  expect(readFileSync(join(directory, NEW, WORKSPACES, "chat", "notes.txt"), "utf8")).toBe("file");
});

it("does not finish a set whose live copy of a sandboxes' folder is missing", () => {
  const directory = fixture();
  const result = shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
REQUESTED_VERSION=0.21.7
BACKUP_DURABLE_VOLUMES=(${GOOGLE} ${TOOLS})
backup_volume() { printf 'archive' > "$BACKUP_TEMP_DIR/$1.tar.gz"; }
date() { printf '20260907T120000Z'; }
begin_backup
printf 'database bytes' > "$BACKUP_TEMP_DIR/postgres.dump"
snapshot_durable_volumes`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("DEPLOY_BACKUP_LIVE_COPY_MISSING");
  expect(existsSync(join(directory, NEW))).toBe(false);
});

function runCopy(directory: string, volume: string, rsyncExit = 0, rsyncErrors: string[] = []) {
  return shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
BACKUP_TEMP_DIR="$BACKUPS_DIR/.backup.test"
mkdir -p "$BACKUP_TEMP_DIR"
APP_IMAGE=app@sha256:abc
log_event() { printf 'event %s\\n' "$1" >&2; }
docker() {
  printf '%s\\n' "$@"
  printf '%s\\n' ${rsyncErrors.map((line) => JSON.stringify(line)).join(" ")} >&2
  return ${rsyncExit}
}
copy_live_volume ${volume}`);
}

it("copies a sandboxes' folder with rsync at the lowest priority, without caches of the tool environments", () => {
  const directory = fixture();
  const tools = runCopy(directory, TOOLS);
  expect(tools.status, tools.stderr).toBe(0);
  const args = tools.stdout.trim().split("\n");
  expect(args.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
  expect(args).toContain(`${TOOLS}:/data:ro`);
  expect(args).toContain(`${directory}:/backups`);
  const command = args.slice(args.indexOf("app@sha256:abc") + 1);
  expect(command.slice(0, 6)).toEqual(["-n", "19", "/usr/bin/ionice", "-c", "3", "/usr/bin/rsync"]);
  expect(command).toEqual(expect.arrayContaining([
    "--archive", "--hard-links", "--numeric-ids", "--no-devices", "--no-specials",
    "--exclude=/*/cache/", "--exclude=/*/home/.cache/",
  ]));
  expect(command.slice(-2)).toEqual(["/data/", `/backups/.backup.test/${TOOLS}/`]);
  // No earlier copy of this folder: everything is copied, nothing is linked.
  expect(command.some((arg) => arg.startsWith("--link-dest"))).toBe(false);

  // The chat files are people's own files: none of them is a cache to leave out.
  const workspaces = runCopy(directory, WORKSPACES);
  expect(workspaces.status, workspaces.stderr).toBe(0);
  expect(workspaces.stdout).not.toContain("--exclude");
});

it("links unchanged files to the newest set that holds a copy of the same folder", () => {
  const directory = fixture();
  mkdirSync(join(directory, OLDER, TOOLS));
  mkdirSync(join(directory, OLD, TOOLS));
  // A newer set made before #577 holds an archive, not a folder; a half-made set and a stray file with
  // a set's name are no sources either.
  mkdirSync(join(directory, NEW));
  writeFileSync(join(directory, NEW, `${TOOLS}.tar.gz`), "archive");
  writeFileSync(join(directory, "20260908T120000Z-to-v0.21.8"), "");
  mkdirSync(join(directory, ".backup.unfinished", TOOLS), { recursive: true });
  const result = runCopy(directory, TOOLS);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`--link-dest=/backups/${OLD}/${TOOLS}`);
});

it("goes on when files vanish during a live copy and stops on any other rsync failure", () => {
  const directory = fixture();
  // rsync exits 24 when a file the bot deleted vanished between listing and copying.
  const vanished = runCopy(directory, TOOLS, 24);
  expect(vanished.status, vanished.stderr).toBe(0);
  expect(vanished.stderr).toContain("event DEPLOY_LIVE_COPY_FILES_VANISHED");
  for (const code of [1, 23, 125]) {
    const broken = runCopy(directory, TOOLS, code);
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain("DEPLOY_LIVE_COPY_FAILED");
  }
});

// rsync exits 23 both for a file the bot shortened while it was read — the risk the owner accepted, as
// tar's exit 1 was — and for a file it could not open, which is a broken copy.
it("accepts exit 23 only when every rsync message is about a file the bot changed meanwhile", () => {
  const directory = fixture();
  const changed = 'rsync: [sender] read errors mapping "/data/chat/home/.agent-browser/Default/History": No data available (61)';
  const vanished = 'file has vanished: "/data/chat/tmp.json"';
  const closing = "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.5.0]";
  const denied = 'rsync: [sender] send_files failed to open "/data/chat/secret": Permission denied (13)';

  const accepted = runCopy(directory, TOOLS, 23, [changed, vanished, closing]);
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.stderr).toContain("event DEPLOY_LIVE_COPY_FILES_CHANGED");
  // rsync's own lines stay in the deploy journal.
  expect(accepted.stderr).toContain(changed);

  for (const errors of [[denied, closing], [changed, denied, closing], [closing], []]) {
    const broken = runCopy(directory, TOOLS, 23, errors);
    expect(broken.status, errors.join(" | ")).not.toBe(0);
    expect(broken.stderr).toContain("DEPLOY_LIVE_COPY_FAILED");
  }
});

it("archives a folder taken with the bot stopped and checks the archive", () => {
  const directory = fixture();
  const run = (tarExit: number) => shell(`
BACKUP_TEMP_DIR=${JSON.stringify(directory)}
APP_IMAGE=app@sha256:abc
docker() { printf '%s ' "$@"; printf '\\n'; return ${tarExit}; }
tar() { printf 'host-check tar %s\\n' "$*" >&2; }
backup_volume ${GOOGLE}`);
  const ok = run(0);
  expect(ok.status, ok.stderr).toBe(0);
  expect(ok.stdout).toContain(`--entrypoint /bin/tar --volume ${GOOGLE}:/data:ro`);
  expect(ok.stdout).toContain(`-czf /backup/${GOOGLE}.tar.gz -C /data .`);
  expect(ok.stderr).toContain("host-check tar -tzf");
  expect(run(1).status).not.toBe(0);
});

// The real rsync with the arguments the deploy builds: an earlier set must never change, and only
// changed files take new space.
it("keeps earlier sets intact and shares only unchanged files with them", () => {
  const directory = fixture();
  const source = mkdtempSync(join(tmpdir(), "osinara-backup-source-"));
  temporary.push(source);
  const chat = join(source, "chat");
  mkdirSync(join(chat, "cache", "pip"), { recursive: true });
  mkdirSync(join(chat, "home", ".cache", "puppeteer"), { recursive: true });
  writeFileSync(join(chat, "cache", "pip", "wheel"), "cache");
  writeFileSync(join(chat, "home", ".cache", "puppeteer", "chrome"), "browser");
  writeFileSync(join(chat, "home", "profile"), "kept");
  writeFileSync(join(chat, "same.txt"), "unchanged");
  writeFileSync(join(chat, "edited.txt"), "first");
  execFileSync("mkfifo", [join(chat, "pipe")]);
  const copy = (name: string) => shell(`
BACKUPS_DIR=${JSON.stringify(directory)}
BACKUP_TEMP_DIR="$BACKUPS_DIR/.backup.${name}"
mkdir -p "$BACKUP_TEMP_DIR"
APP_IMAGE=app@sha256:abc
# Runs the rsync command the deploy hands to Docker, on the host paths behind its mounts.
docker() {
  local -a command=()
  local arg started=0
  for arg in "$@"; do
    if [[ "$started" -eq 1 ]]; then
      arg="\${arg/#\\/data\\//${source}/}"
      arg="\${arg/#\\/backups\\//${directory}/}"
      arg="\${arg/#--link-dest=\\/backups\\//--link-dest=${directory}/}"
      command+=("$arg")
    elif [[ "$arg" == /usr/bin/rsync ]]; then
      started=1
      command+=(rsync)
    fi
  done
  "\${command[@]}"
}
copy_live_volume ${TOOLS}
mv "$BACKUP_TEMP_DIR" "$BACKUPS_DIR/${name}"`);

  // The fixture's earlier sets hold no copy of this folder, so the first copy links nothing.
  const firstSet = "20260908T120000Z-to-v0.21.8";
  const created = copy(firstSet);
  expect(created.status, created.stderr).toBe(0);
  const firstCopy = join(directory, firstSet, TOOLS, "chat");
  expect(readdirSync(firstCopy).sort()).toEqual(["edited.txt", "home", "same.txt"]);
  expect(readdirSync(join(firstCopy, "home"))).toEqual(["profile"]);

  writeFileSync(join(chat, "edited.txt"), "second, longer");
  rmSync(join(chat, "home", "profile"));
  const secondSet = "20260909T120000Z-to-v0.21.9";
  const linked = copy(secondSet);
  expect(linked.status, linked.stderr).toBe(0);
  const secondCopy = join(directory, secondSet, TOOLS, "chat");
  expect(statSync(join(secondCopy, "same.txt")).ino).toBe(statSync(join(firstCopy, "same.txt")).ino);
  expect(statSync(join(secondCopy, "edited.txt")).ino).not.toBe(statSync(join(firstCopy, "edited.txt")).ino);
  expect(readFileSync(join(secondCopy, "edited.txt"), "utf8")).toBe("second, longer");
  expect(readFileSync(join(firstCopy, "edited.txt"), "utf8")).toBe("first");
  expect(readdirSync(join(secondCopy, "home"))).toEqual([]);
  expect(readFileSync(join(firstCopy, "home", "profile"), "utf8")).toBe("kept");
});

it("does not prune in the deployment orchestrator before snapshot completion", () => {
  const source = readFileSync("scripts/production-deploy/main.sh", "utf8");
  expect(source.indexOf("prune_old_deploy_backups")).toBeGreaterThan(source.indexOf("snapshot_durable_volumes"));
});
