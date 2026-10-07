/**
 * Crash-safe host process locks.
 *
 * Exports:
 * - `InstallationLockSecurity`: injectable ownership identity for isolated tests.
 * - `acquireInstallationLock`: excludes a second initial installation.
 * - `acquireDeployLock`: excludes operator commands while the release controller deploys; it is
 *   the same file and kernel lock the controller takes with `flock`.
 * - `withDeployLock`: runs one operator action under that lock.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

import { InstallerError } from "./errors.js";

const LOCK_MODE = 0o600;
const FLOCK_PATH = "/usr/bin/flock";
const SHELL_PATH = "/bin/sh";
const LOCK_FILE_DESCRIPTOR = 3;
const LOCK_FILE_DESCRIPTOR_PATH = `/proc/self/fd/${LOCK_FILE_DESCRIPTOR}`;
const LOCK_READY = "locked\n";
const LOCK_HOLDER_SOURCE = `printf '${LOCK_READY}'\nIFS= read -r _ || true\n`;
// The release controller holds the deploy lock for about half a second on every idle minute tick;
// an operator command waits that out instead of reporting a release that is not running.
const DEPLOY_LOCK_WAIT_SECONDS = 30;

export interface InstallationLockSecurity {
  readonly gid: number;
  readonly uid: number;
}

const ROOT_SECURITY: InstallationLockSecurity = Object.freeze({ gid: 0, uid: 0 });

async function openTrustedLock(path: string, security: InstallationLockSecurity) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      LOCK_MODE,
    );
    await handle.chown(security.uid, security.gid);
    await handle.chmod(LOCK_MODE);
    await handle.writeFile(`${process.pid}\n`, "ascii");
    await handle.sync();
    return handle;
  } catch (error) {
    if (handle) await handle.close();
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  // A persistent file is safe to reuse only when its exact host metadata remains trusted.
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== security.uid
    || metadata.gid !== security.gid
    || (metadata.mode & 0o777) !== LOCK_MODE
    || await realpath(path) !== path
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_LOCK_UNTRUSTED",
      `Lock-файл ${path} имеет небезопасные права, владельца или тип`,
    );
  }
  return await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
}

interface LockBusyError {
  readonly code: string;
  readonly message: string;
}

/** `null` fails at once when the lock is held; a number waits up to that many seconds. */
type LockWait = number | null;

export async function acquireInstallationLock(
  path: string,
  security: InstallationLockSecurity = ROOT_SECURITY,
): Promise<() => Promise<void>> {
  return await acquireHostProcessLock(path, {
    code: "OSINARA_INSTALL_LOCKED",
    message: "Другая установка уже выполняется",
  }, null, security);
}

export async function acquireDeployLock(
  path: string,
  security: InstallationLockSecurity = ROOT_SECURITY,
  waitSeconds: number = DEPLOY_LOCK_WAIT_SECONDS,
): Promise<() => Promise<void>> {
  return await acquireHostProcessLock(path, {
    code: "OSINARA_OPERATION_DEPLOY_IN_PROGRESS",
    message: "Сейчас устанавливается обновление Osinara. Повторите команду через несколько минут",
  }, waitSeconds, security);
}

/** A lock release failure never replaces the action's own failure, which is the useful one. */
export async function withDeployLock<T>(
  path: string,
  operation: () => Promise<T>,
  security: InstallationLockSecurity = ROOT_SECURITY,
  waitSeconds: number = DEPLOY_LOCK_WAIT_SECONDS,
): Promise<T> {
  const release = await acquireDeployLock(path, security, waitSeconds);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  await release();
  return result;
}

/** Leaves the trusted file in place; only the kernel lock represents a live owner. */
async function acquireHostProcessLock(
  path: string,
  busy: LockBusyError,
  wait: LockWait,
  security: InstallationLockSecurity,
): Promise<() => Promise<void>> {
  const handle = await openTrustedLock(path, security);
  const waitArgs = wait === null ? ["--nonblock"] : ["--timeout", String(wait)];
  const child = spawn(
    FLOCK_PATH,
    ["--exclusive", ...waitArgs, "--no-fork", LOCK_FILE_DESCRIPTOR_PATH, SHELL_PATH, "-c", LOCK_HOLDER_SOURCE],
    { stdio: ["pipe", "pipe", "ignore", handle.fd] },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      child.once("error", () => {
        if (settled) return;
        settled = true;
        reject(new InstallerError(
          "OSINARA_INSTALL_LOCK_FAILED",
          `Не удалось запустить ${FLOCK_PATH}; установите util-linux и повторите операцию`,
        ));
      });
      child.stdout?.once("data", (bytes: Buffer) => {
        if (settled || bytes.toString("ascii") !== LOCK_READY) return;
        settled = true;
        resolve();
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        reject(code === 1
          ? new InstallerError(busy.code, busy.message)
          : new InstallerError(
            "OSINARA_INSTALL_LOCK_FAILED",
            `Процесс ${FLOCK_PATH} завершился с кодом ${String(code)} до получения lock`,
          ));
      });
    });
    // The holder inherited the same open-file description; parent must drop its duplicate so
    // kernel ownership ends exactly with the holder process, including parent crashes.
    await handle.close();
  } catch (error) {
    await handle.close();
    throw error;
  }

  return async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0
          ? resolve()
          : reject(new Error(`lock holder exited with code ${String(code)}`)));
        child.stdin?.end();
      });
    } catch (error) {
      throw new InstallerError(
        "OSINARA_INSTALL_LOCK_RELEASE_FAILED",
        "Операция завершена, но блокировку не удалось освободить; проверьте процесс-владелец",
        { cause: error },
      );
    }
  };
}
