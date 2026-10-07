/**
 * Self-updating deployment controller on a host installed with `osinara install`.
 *
 * Exports:
 * - `UPDATER_HOST_COMMANDS` / `findMissingHostCommands`: host tools the controller runs.
 * - `UpdaterLayout` / `INSTALLED_UPDATER_LAYOUT`: launcher, controller versions, staging, units.
 * - `installUpdaterFromImage`: places the controller and units the release app image carries.
 * - `updaterUnitPaths` / `requireAbsentUpdaterUnits`: the two unit files a host may not already have.
 * - `enableUpdater`, `removeUpdaterUnits`, `assertUpdaterActive`: the systemd side.
 *
 * Key constructs:
 * - The release app image is the only source. Its digest is bound by the release manifest, and
 *   every later update takes its controller from the same place (`scripts/production-deploy/`).
 * - The root installer process creates every file, so they are root-owned; modes are the ones
 *   the launcher verifies before each run.
 */
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { InstallerError } from "./errors.js";
import { ATTEMPT_DIR, BIN_DIR, CONTROLLER_ROOT, LAUNCHER_PATH, SYSTEMD_UNIT_DIR } from "./host-layout.js";
import type { runHostCommand } from "./process-runner.js";

type HostCommandRunner = typeof runHostCommand;

/** Everything `production-deploy` requires (`require_server_boundary`) plus bash and systemd. */
export const UPDATER_HOST_COMMANDS = [
  "awk", "bash", "cmp", "curl", "df", "docker", "find", "flock", "install", "jq", "ln", "mktemp",
  "mv", "readlink", "sha256sum", "sort", "stat", "systemctl", "tail", "tar",
] as const;

const DEPLOY_IMAGE_DIR = "/app/deploy";
const CONTROLLER_FILE_PATTERN = /^[a-z0-9-]+\.(sh|jq)$/u;
const REQUIRED_CONTROLLER_FILES = ["launcher.sh", "main.sh"] as const;
const UPDATER_UNITS = ["osinara-deploy.service", "osinara-deploy.timer"] as const;
const UPDATER_TIMER = "osinara-deploy.timer";
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;

export interface UpdaterLayout {
  readonly binDir: string;
  readonly controllerRoot: string;
  readonly launcherPath: string;
  readonly stagingDir: string;
  readonly systemdDir: string;
}

export const INSTALLED_UPDATER_LAYOUT: UpdaterLayout = Object.freeze({
  binDir: BIN_DIR,
  controllerRoot: CONTROLLER_ROOT,
  launcherPath: LAUNCHER_PATH,
  stagingDir: `${ATTEMPT_DIR}/deploy`,
  systemdDir: SYSTEMD_UNIT_DIR,
});

interface DeployTree {
  readonly controllerFiles: readonly string[];
  readonly units: ReadonlyMap<string, Buffer>;
}

export async function findMissingHostCommands(
  searchDirs: readonly string[],
  commands: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const command of commands) {
    let found = false;
    for (const directory of searchDirs) {
      try {
        await access(join(directory, command), constants.X_OK);
        found = true;
        break;
      } catch {
        // A search path entry without this executable is the ordinary case; try the next one.
      }
    }
    if (!found) missing.push(command);
  }
  return missing;
}

function invalidDeployTree(reason: string): InstallerError {
  return new InstallerError(
    "OSINARA_INSTALL_UPDATER_INVALID",
    `Образ релиза содержит некорректный контроллер обновлений (${reason}). Установка остановлена до изменения сервера`,
  );
}

async function requireEntryType(path: string, type: "directory" | "file"): Promise<void> {
  const metadata = await lstat(path);
  const valid = type === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!valid || metadata.isSymbolicLink()) throw invalidDeployTree(`${path} не является обычным объектом`);
}

/** The image tree is exactly `controller/` with flat modules and `systemd/` with the two units. */
async function readDeployTree(root: string): Promise<DeployTree> {
  const top = (await readdir(root)).sort();
  if (top.join(",") !== "controller,systemd") throw invalidDeployTree(`лишние записи: ${top.join(", ")}`);
  await requireEntryType(join(root, "controller"), "directory");
  await requireEntryType(join(root, "systemd"), "directory");

  const controllerFiles = (await readdir(join(root, "controller"))).sort();
  for (const name of controllerFiles) {
    if (!CONTROLLER_FILE_PATTERN.test(name)) throw invalidDeployTree(`неожиданный файл ${name}`);
    await requireEntryType(join(root, "controller", name), "file");
  }
  for (const name of REQUIRED_CONTROLLER_FILES) {
    if (!controllerFiles.includes(name)) throw invalidDeployTree(`нет ${name}`);
  }

  const unitNames = (await readdir(join(root, "systemd"))).sort();
  if (unitNames.join(",") !== [...UPDATER_UNITS].join(",")) {
    throw invalidDeployTree(`юниты systemd: ${unitNames.join(", ")}`);
  }
  const units = new Map<string, Buffer>();
  for (const name of UPDATER_UNITS) {
    await requireEntryType(join(root, "systemd", name), "file");
    units.set(name, await readFile(join(root, "systemd", name)));
  }
  return { controllerFiles, units };
}

function existingUnitError(path: string, cause?: unknown): InstallerError {
  return new InstallerError(
    "OSINARA_INSTALL_EXISTING_STATE",
    `На сервере уже есть ${path}; установка не перезаписывает файлы systemd. Удалите его или поставьте Osinara на чистый сервер`,
    cause === undefined ? undefined : { cause },
  );
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw existingUnitError(path);
}

export function updaterUnitPaths(systemdDir: string): string[] {
  return UPDATER_UNITS.map((unit) => join(systemdDir, unit));
}

export async function requireAbsentUpdaterUnits(systemdDir: string): Promise<void> {
  for (const path of updaterUnitPaths(systemdDir)) await requireAbsent(path);
}

/** The same syntax check the running controller applies to the controller of every update. */
async function requireValidShell(
  directory: string,
  files: readonly string[],
  run: HostCommandRunner,
): Promise<void> {
  for (const name of files.filter((file) => file.endsWith(".sh"))) {
    try {
      await run({ args: ["-n", join(directory, name)], command: "bash", timeoutMs: COMMAND_TIMEOUT_MS });
    } catch (error) {
      throw new InstallerError(
        "OSINARA_INSTALL_UPDATER_INVALID",
        `Образ релиза содержит некорректный контроллер обновлений (${name} не проходит проверку bash). Установка остановлена до изменения сервера`,
        { cause: error },
      );
    }
  }
}

async function createRootDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o750 });
  // mkdir applies the process umask; the launcher verifies the exact mode.
  await chmod(path, 0o750);
}

/** Writes both units or none: a partial pair is removed before the error reaches the caller. */
async function writeUpdaterUnits(
  units: ReadonlyMap<string, Buffer>,
  systemdDir: string,
  run: HostCommandRunner,
): Promise<string[]> {
  const written: string[] = [];
  try {
    for (const [name, bytes] of units) {
      const path = join(systemdDir, name);
      try {
        await writeFile(path, bytes, { flag: "wx", mode: 0o644 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw existingUnitError(path, error);
        throw error;
      }
      written.push(path);
      await chmod(path, 0o644);
    }
    await run({ args: ["daemon-reload"], command: "systemctl", timeoutMs: COMMAND_TIMEOUT_MS });
    return written;
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw error;
  }
}

/** Returns the unit files it created; everything else lives under the installer-owned base. */
export async function installUpdaterFromImage(input: {
  readonly appImage: string;
  readonly layout: UpdaterLayout;
  readonly releaseVersion: string;
  readonly run: HostCommandRunner;
}): Promise<string[]> {
  const { layout, run } = input;
  await requireAbsentUpdaterUnits(layout.systemdDir);
  const archive = await run({
    args: [
      "run", "--rm", "--network", "none", "--entrypoint", "/bin/tar", input.appImage,
      "-c", "-C", DEPLOY_IMAGE_DIR, ".",
    ],
    command: "docker",
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  await mkdir(layout.stagingDir, { mode: 0o700 });
  await run({
    args: ["-x", "--no-same-owner", "--no-same-permissions", "-C", layout.stagingDir],
    command: "tar",
    stdin: archive,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const tree = await readDeployTree(layout.stagingDir);
  await requireValidShell(join(layout.stagingDir, "controller"), tree.controllerFiles, run);

  const versionName = `v${input.releaseVersion}`;
  const versionDir = join(layout.controllerRoot, versionName);
  await createRootDirectory(layout.binDir);
  await createRootDirectory(layout.controllerRoot);
  await rename(join(layout.stagingDir, "controller"), versionDir);
  await chmod(versionDir, 0o750);
  for (const name of tree.controllerFiles) await chmod(join(versionDir, name), 0o640);
  await copyFile(join(versionDir, "launcher.sh"), layout.launcherPath, constants.COPYFILE_EXCL);
  await chmod(layout.launcherPath, 0o750);
  await symlink(versionName, join(layout.controllerRoot, "current"));
  await rm(layout.stagingDir, { recursive: true });
  return await writeUpdaterUnits(tree.units, layout.systemdDir, run);
}

export async function enableUpdater(run: HostCommandRunner): Promise<void> {
  await run({ args: ["enable", "--now", UPDATER_TIMER], command: "systemctl", timeoutMs: COMMAND_TIMEOUT_MS });
}

export async function removeUpdaterUnits(paths: readonly string[], run: HostCommandRunner): Promise<void> {
  for (const path of paths) await rm(path, { force: true });
  await run({ args: ["daemon-reload"], command: "systemctl", timeoutMs: COMMAND_TIMEOUT_MS });
}

export async function assertUpdaterActive(run: HostCommandRunner): Promise<void> {
  try {
    await run({ args: ["is-active", "--quiet", UPDATER_TIMER], command: "systemctl", timeoutMs: 30_000 });
  } catch (error) {
    throw new InstallerError(
      "OSINARA_DOCTOR_UPDATER_INACTIVE",
      `Автообновление выключено: таймер ${UPDATER_TIMER} не работает. Включите его: systemctl enable --now ${UPDATER_TIMER}`,
      { cause: error },
    );
  }
}
