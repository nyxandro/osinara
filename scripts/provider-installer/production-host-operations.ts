/**
 * Root-owned production host operations for the initial installer.
 *
 * Exports:
 * - `createProductionHostOperations`: binds secure files, Docker Compose, HTTPS, webhook, and bootstrap.
 *
 * Key constructs:
 * - Exact `/opt/osinara` paths, recoverable attempt state, durable migration marker, and process lock.
 * - Digest-only application Compose plus an isolated pinned Traefik project (`managed` TLS mode), or
 *   verification that an operator-owned proxy already answers for the hostname (`external` TLS mode).
 * - Bounded health checks and subprocess output without shell interpolation.
 */
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";

import type { HostInstallationOperations, HostInstallationStageInput, HostTlsInput } from "./host-executor.js";
import {
  buildTlsEnvironment,
  parseBootstrapProcessOutput,
  releaseEnvironmentFromManifest,
} from "./host-contracts.js";
import { probeExternalProxy } from "./external-proxy-probe.js";
import { readInstallationBundle, validateInstallationBundle } from "./installation-bundle.js";
import { recoverPreMigrationInstallationAttempt } from "./installation-attempt.js";
import { acquireInstallationLock } from "./installation-lock.js";
import { InstallerError } from "./errors.js";
import { runHostCommand } from "./process-runner.js";
import { configureTelegramWebhook } from "./telegram-webhook.js";

const BASE_DIR = "/opt/osinara";
const ATTEMPT_DIR = `${BASE_DIR}/.install-attempt`;
const MIGRATION_MARKER_PATH = `${ATTEMPT_DIR}/migration-started`;
const LOCK_PATH = "/run/osinara-install.lock";
const ENV_PATH = `${BASE_DIR}/.env`;
const MODEL_CONFIG_PATH = `${BASE_DIR}/agent-model-providers.json`;
const RELEASE_ENV_PATH = `${BASE_DIR}/release.env`;
const COMPOSE_PATH = `${BASE_DIR}/compose.installation.json`;
const MANIFEST_PATH = `${BASE_DIR}/osinara-deployment.json`;
const TLS_DIR = `${BASE_DIR}/tls`;
const TLS_ENV_PATH = `${TLS_DIR}/.env`;
const TLS_COMPOSE_PATH = `${TLS_DIR}/compose.yaml`;
const TLS_DYNAMIC_DIR = `${TLS_DIR}/dynamic`;
const TLS_ROUTE_PATH = `${TLS_DYNAMIC_DIR}/osinara.yaml`;
const EDGE_LOOPBACK_PORT = 8082;
const HTTPS_ATTEMPTS = 60;
// An operator attaching their own proxy needs time to connect it after the edge appears.
const EXTERNAL_HTTPS_ATTEMPTS = 180;
const HTTPS_INTERVAL_MS = 5_000;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1_000;
const PRODUCTION_DOCKER_RESOURCES = [
  "osinara-production-postgres-data",
  "osinara-production-memory-embedding-model-e5",
  "osinara-production-google-workspace-credentials",
  "osinara-production-sandbox-data",
  "osinara-production-tool-environments",
  "osinara-production-eve-workflow-data-v032",
  "osinara-production-workspace-data",
  "osinara-production-app-network",
  "osinara-production-edge-frontend",
  "osinara-production-sandbox-control",
  "osinara-production-sandbox-egress",
  "osinara-tls-traefik-data",
] as const;

async function writeRootFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.chown(0, 0);
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  const directory = await open(path.slice(0, path.lastIndexOf("/")), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function composeArgs(file: string, envFiles: readonly string[], args: readonly string[]): string[] {
  return [
    "compose",
    ...envFiles.flatMap((envFile) => ["--env-file", envFile]),
    "--file",
    file,
    ...args,
  ];
}

async function dockerCompose(
  file: string,
  envFiles: readonly string[],
  args: readonly string[],
): Promise<Buffer> {
  return await runHostCommand({
    args: composeArgs(file, envFiles, args),
    command: "docker",
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new InstallerError(
      "OSINARA_INSTALL_PORT_UNAVAILABLE",
      `Порт ${port} занят. Освободите его перед установкой`,
      { cause: error },
    )));
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function requirePhysicalRootDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || metadata.gid !== 0
    || await realpath(path) !== path
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_HOST_PATH_INVALID",
      `Каталог ${path} должен быть физическим root:root каталогом`,
    );
  }
}

/** Creates stateful operations used by one executor invocation. */
export function createProductionHostOperations(): HostInstallationOperations {
  let ownsBaseDirectory = false;

  const cleanupOwnedBaseDirectory = async (): Promise<void> => {
    if (!ownsBaseDirectory) return;
    await requirePhysicalRootDirectory(ATTEMPT_DIR);
    await rm(BASE_DIR, { force: true, recursive: true });
    ownsBaseDirectory = false;
  };

  return {
    acquireLock: async () => {
      return await acquireInstallationLock(LOCK_PATH);
    },
    assertCleanState: async () => {
      // A prior crash is restartable only while its durable marker proves migrations never began.
      await recoverPreMigrationInstallationAttempt({
        attemptDir: ATTEMPT_DIR,
        baseDir: BASE_DIR,
        migrationMarker: MIGRATION_MARKER_PATH,
      });
      const projects = await runHostCommand({
        args: ["ps", "-a", "--filter", "label=com.docker.compose.project=osinara-production", "--quiet"],
        command: "docker",
        timeoutMs: 30_000,
      });
      if (projects.toString("utf8").trim()) {
        throw new InstallerError(
          "OSINARA_INSTALL_EXISTING_STATE",
          "На сервере уже существуют контейнеры проекта osinara-production",
        );
      }
      for (const resource of PRODUCTION_DOCKER_RESOURCES) {
        const volumes = await runHostCommand({
          args: ["volume", "ls", "--filter", `name=^${resource}$`, "--format", "{{.Name}}"],
          command: "docker",
          timeoutMs: 30_000,
        });
        const networks = await runHostCommand({
          args: ["network", "ls", "--filter", `name=^${resource}$`, "--format", "{{.Name}}"],
          command: "docker",
          timeoutMs: 30_000,
        });
        if (volumes.toString("utf8").trim() === resource
          || networks.toString("utf8").trim() === resource) {
          throw new InstallerError(
            "OSINARA_INSTALL_EXISTING_STATE",
            `На сервере уже существует Docker resource ${resource}; автоматическое подключение старых данных запрещено`,
          );
        }
      }
    },
    assertHostPrerequisites: async () => {
      if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
        throw new InstallerError(
          "OSINARA_INSTALL_ROOT_REQUIRED",
          "Первичная установка должна выполняться пользователем root",
        );
      }
      if (process.platform !== "linux" || process.arch !== "x64") {
        throw new InstallerError(
          "OSINARA_INSTALL_PLATFORM_UNSUPPORTED",
          "Этот release CLI поддерживает только GNU/Linux x86_64 на glibc",
        );
      }
      await runHostCommand({ args: ["info"], command: "docker", timeoutMs: 30_000 });
      await runHostCommand({ args: ["compose", "version"], command: "docker", timeoutMs: 30_000 });
    },
    commit: async () => {
      await rm(ATTEMPT_DIR, { force: true, recursive: true });
    },
    configureWebhook: async (input) => {
      await configureTelegramWebhook({ ...input, fetch: globalThis.fetch, timeoutMs: 30_000 });
    },
    createOwnerBootstrap: async () => {
      const stdout = await dockerCompose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], [
        "run",
        "--no-deps",
        "--rm",
        "--entrypoint",
        "node",
        "agent",
        ".runtime/scripts/create-bootstrap-code.js",
      ]);
      return parseBootstrapProcessOutput(stdout);
    },
    markMigrationStarted: async () => {
      // Atomic write plus file and parent-directory fsync makes the no-cleanup boundary durable.
      await writeRootFile(MIGRATION_MARKER_PATH, Buffer.from("migration-started\n", "ascii"), 0o600);
    },
    preflight: async (input: HostTlsInput) => {
      await assertPortAvailable(EDGE_LOOPBACK_PORT);
      await dockerCompose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], ["config", "--quiet"]);
      if (input.tlsMode === "managed") {
        await assertPortAvailable(80);
        await assertPortAvailable(443);
        await dockerCompose(TLS_COMPOSE_PATH, [TLS_ENV_PATH], ["config", "--quiet"]);
        return;
      }
      await probeExternalProxy({ fetch: globalThis.fetch, hostname: input.hostname, listenPort: EDGE_LOOPBACK_PORT });
    },
    pullImages: async (input: HostTlsInput) => {
      await dockerCompose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], ["pull", "--quiet"]);
      if (input.tlsMode === "managed") {
        await dockerCompose(TLS_COMPOSE_PATH, [TLS_ENV_PATH], ["pull", "--quiet"]);
      }
    },
    rollbackPreparedState: async () => {
      if (!ownsBaseDirectory) {
        throw new InstallerError(
          "OSINARA_INSTALL_ROLLBACK_OWNERSHIP_MISSING",
          "Installer не подтвердил владение подготовленным каталогом; автоматическое удаление запрещено",
        );
      }
      await cleanupOwnedBaseDirectory();
    },
    stage: async (input: HostInstallationStageInput) => {
      const files = await readInstallationBundle(input.archive);
      const requireFile = (path: string): Buffer => {
        const bytes = files.get(path);
        if (!bytes) throw new InstallerError(
          "OSINARA_INSTALL_BUNDLE_ENTRY_INVALID",
          `Installation bundle не содержит ${path}`,
        );
        return bytes;
      };
      const releaseEnvironment = releaseEnvironmentFromManifest(
        requireFile("installation/osinara-deployment.json"),
        input.releaseVersion,
      );

      try {
        // Non-recursive creation proves this process owns the fresh base before cleanup is enabled.
        await mkdir(BASE_DIR, { mode: 0o750 });
        ownsBaseDirectory = true;
        await chown(BASE_DIR, 0, 0);
        await chmod(BASE_DIR, 0o750);
        await mkdir(ATTEMPT_DIR, { mode: 0o700 });
        await chown(ATTEMPT_DIR, 0, 0);
        await chmod(ATTEMPT_DIR, 0o700);
        await mkdir(TLS_DIR, { mode: 0o750 });
        await chown(TLS_DIR, 0, 0);
        await chmod(TLS_DIR, 0o750);
        await mkdir(TLS_DYNAMIC_DIR, { mode: 0o750 });
        await chown(TLS_DYNAMIC_DIR, 0, 0);
        await chmod(TLS_DYNAMIC_DIR, 0o750);
        await requirePhysicalRootDirectory(BASE_DIR);
        await requirePhysicalRootDirectory(ATTEMPT_DIR);
        await requirePhysicalRootDirectory(TLS_DIR);
        await requirePhysicalRootDirectory(TLS_DYNAMIC_DIR);
        await writeRootFile(ENV_PATH, input.environmentBytes, 0o600);
        await writeRootFile(MODEL_CONFIG_PATH, input.modelConfigBytes, 0o644);
        await writeRootFile(RELEASE_ENV_PATH, releaseEnvironment, 0o600);
        await writeRootFile(COMPOSE_PATH, requireFile("installation/compose.installation.json"), 0o644);
        await writeRootFile(MANIFEST_PATH, requireFile("installation/osinara-deployment.json"), 0o644);
        if (input.tlsMode === "managed") {
          await writeRootFile(TLS_COMPOSE_PATH, requireFile("installation/traefik-compose.yaml"), 0o644);
        }
        // The route file is written in both modes: an external Traefik can include it as-is.
        await writeRootFile(TLS_ROUTE_PATH, requireFile("installation/traefik-osinara.yaml"), 0o644);
        await writeRootFile(
          TLS_ENV_PATH,
          buildTlsEnvironment({ hostname: input.hostname, mode: input.tlsMode }),
          0o600,
        );
      } catch (error) {
        await cleanupOwnedBaseDirectory();
        throw error;
      }
    },
    startApplication: async () => {
      await dockerCompose(COMPOSE_PATH, [ENV_PATH, RELEASE_ENV_PATH], [
        "up", "--detach", "--remove-orphans", "--no-build", "--wait", "--wait-timeout", "600",
      ]);
    },
    startTls: async () => {
      await dockerCompose(TLS_COMPOSE_PATH, [TLS_ENV_PATH], [
        "up", "--detach", "--remove-orphans", "--no-build", "--wait", "--wait-timeout", "120",
      ]);
    },
    validateBundle: validateInstallationBundle,
    waitForPublicHttps: async (input: HostTlsInput) => {
      const url = `https://${input.hostname}/eve/v1/health`;
      const attempts = input.tlsMode === "external" ? EXTERNAL_HTTPS_ATTEMPTS : HTTPS_ATTEMPTS;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await fetch(url, {
            redirect: "error",
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok && response.url === url) return;
        } catch {
          // ACME issuance is asynchronous; the bounded outer loop owns the only allowed wait.
        }
        if (attempt < attempts) await sleep(HTTPS_INTERVAL_MS);
      }
      throw new InstallerError(
        "OSINARA_INSTALL_HTTPS_HEALTH_TIMEOUT",
        `Публичный HTTPS ${input.hostname} не стал доступен за отведённое время. Проверьте DNS, порты 80/443 и настройку прокси`,
      );
    },
  };
}
