/**
 * Root-owned file layout of a host installed with `osinara install`.
 *
 * Exports:
 * - Fixed paths shared by the installer, operator commands, and the release controller.
 * - `releaseDirectory`: the directory one release version occupies.
 * - `resolveCurrentRelease`: the release `current` selects, resolved once per command.
 *
 * The layout is the release controller's (`scripts/production-deploy/`): releases live in
 * `releases/vX.Y.Z`, `current` selects one, and the controller switches it on every update.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { InstallerError } from "./errors.js";

export const BASE_DIR = "/opt/osinara";
export const ENV_PATH = `${BASE_DIR}/.env`;
export const MODEL_CONFIG_PATH = `${BASE_DIR}/agent-model-providers.json`;
export const RELEASES_DIR = `${BASE_DIR}/releases`;
export const CURRENT_LINK = `${BASE_DIR}/current`;
// The controller keeps this copy of the current release's image references up to date.
export const RELEASE_ENV_PATH = `${BASE_DIR}/release.env`;
export const ATTEMPT_DIR = `${BASE_DIR}/.install-attempt`;
export const TLS_DIR = `${BASE_DIR}/tls`;
export const TLS_ENV_PATH = `${TLS_DIR}/.env`;
export const TLS_COMPOSE_PATH = `${TLS_DIR}/compose.yaml`;
export const TLS_DYNAMIC_DIR = `${TLS_DIR}/dynamic`;
export const TLS_ROUTE_PATH = `${TLS_DYNAMIC_DIR}/osinara.yaml`;
export const BIN_DIR = `${BASE_DIR}/bin`;
export const LAUNCHER_PATH = `${BIN_DIR}/production-deploy.sh`;
export const CONTROLLER_ROOT = `${BIN_DIR}/controller`;
export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";
export const DEPLOY_LOCK_PATH = "/run/lock/osinara-production-deploy.lock";
// Selects the controller's graph without the CLIProxy gateway; see `require_deployment_profile`.
export const DEPLOYMENT_PROFILE = "installation";
export const INSTALLATION_COMPOSE_NAME = "compose.installation.json";
export const MANIFEST_NAME = "osinara-deployment.json";
export const RELEASE_ENV_NAME = "release.env";

const RELEASE_DIRECTORY_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export interface CurrentRelease {
  readonly composePath: string;
  readonly directory: string;
  readonly manifestPath: string;
  readonly releaseEnvPath: string;
}

export function releaseDirectory(version: string): string {
  return join(RELEASES_DIR, `v${version}`);
}

/** Resolved once, so a release switch during a command cannot mix files of two releases. */
export async function resolveCurrentRelease(
  currentLink: string = CURRENT_LINK,
  releasesDir: string = RELEASES_DIR,
): Promise<CurrentRelease> {
  let directory: string;
  try {
    if (!(await lstat(currentLink)).isSymbolicLink()) throw new Error("current is not a symbolic link");
    directory = await realpath(currentLink);
  } catch (error) {
    throw invalidCurrentRelease(currentLink, error);
  }
  if (dirname(directory) !== await realpath(releasesDir)
    || !RELEASE_DIRECTORY_PATTERN.test(basename(directory))) {
    throw invalidCurrentRelease(currentLink, new Error(`current resolves to ${directory}`));
  }
  return {
    composePath: join(directory, INSTALLATION_COMPOSE_NAME),
    directory,
    manifestPath: join(directory, MANIFEST_NAME),
    releaseEnvPath: join(directory, RELEASE_ENV_NAME),
  };
}

function invalidCurrentRelease(currentLink: string, cause: unknown): InstallerError {
  return new InstallerError(
    "OSINARA_OPERATION_RELEASE_INVALID",
    `Ссылка ${currentLink} не указывает на установленный релиз. Проверьте журнал обновлений: journalctl -u osinara-deploy.service`,
    { cause },
  );
}
