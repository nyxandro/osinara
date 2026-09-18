/**
 * Transactional initial host installation orchestrator.
 *
 * Exports:
 * - `HostInstallationStageInput`: complete validated bytes and installation metadata for staging.
 * - `HostInstallationOperations`: explicit privileged filesystem, Docker, TLS, and Telegram boundary.
 * - `createHostInstallationExecutor`: orders reversible preparation and irreversible migration work.
 *
 * Key constructs:
 * - TLS mode is an operator decision: `managed` starts the bundled Traefik, `external` only verifies
 *   that an existing host proxy already answers for the hostname.
 * - Candidate model/environment generation without legacy proxy credentials.
 * - Full rollback only before migrations can mutate durable PostgreSQL state.
 * - Durable migration-start marker and explicit ambiguous terminal state after that boundary.
 * - Primary installation error precedence over release-lock cleanup errors.
 */
import { createHash } from "node:crypto";

import { buildModelProviderConfig } from "../../agent/lib/provider-catalog/model-provider-config-builder.js";
import type {
  InstallationExecutionInput,
  InstallationExecutionResult,
  TlsMode,
} from "./contracts.js";
import { InstallerError } from "./errors.js";

export interface HostInstallationStageInput {
  readonly archive: Uint8Array;
  readonly environmentBytes: Buffer;
  readonly hostname: string;
  readonly modelConfigBytes: Buffer;
  readonly releaseVersion: string;
  readonly tlsMode: TlsMode;
}

export interface HostTlsInput {
  readonly hostname: string;
  readonly tlsMode: TlsMode;
}

export interface HostInstallationOperations {
  readonly acquireLock: () => Promise<() => Promise<void>>;
  readonly assertCleanState: () => Promise<void>;
  readonly assertHostPrerequisites: () => Promise<void>;
  readonly commit: () => Promise<void>;
  readonly configureWebhook: (input: {
    hostname: string;
    secretToken: string;
    token: string;
  }) => Promise<void>;
  readonly createOwnerBootstrap: () => Promise<InstallationExecutionResult>;
  readonly markMigrationStarted: () => Promise<void>;
  readonly preflight: (input: HostTlsInput) => Promise<void>;
  readonly pullImages: (input: HostTlsInput) => Promise<void>;
  readonly rollbackPreparedState: () => Promise<void>;
  readonly stage: (input: HostInstallationStageInput) => Promise<void>;
  readonly startApplication: () => Promise<void>;
  readonly startTls: () => Promise<void>;
  readonly validateBundle: (archive: Uint8Array) => Promise<void>;
  readonly waitForPublicHttps: (input: HostTlsInput) => Promise<void>;
}

function requireExactArchiveChecksum(input: InstallationExecutionInput): void {
  const actual = createHash("sha256").update(input.assets.archive).digest("hex");
  if (actual !== input.assets.archiveSha256) {
    throw new InstallerError(
      "OSINARA_INSTALL_RELEASE_CHECKSUM_MISMATCH",
      "SHA-256 installation bundle изменился до начала установки",
    );
  }
}

function requireEnvironmentValue(value: string, name: string): string {
  if (!value || /['\r\n\0]/u.test(value)) {
    throw new InstallerError(
      "OSINARA_INSTALL_ENVIRONMENT_VALUE_INVALID",
      `Значение ${name} нельзя безопасно записать в конфигурацию установки`,
    );
  }
  // Compose treats single-quoted env-file values literally, including `$` and backslashes.
  return `'${value}'`;
}

/** Produces a closed environment file with only secrets and genuine environment-specific values. */
function buildEnvironment(input: InstallationExecutionInput): Buffer {
  const values: Array<readonly [string, string]> = [
    ["DATABASE_URL", `postgresql://osinara:${input.internalSecrets.postgresPassword}@postgres:5432/osinara`],
    ["INVITATION_SIGNING_SECRET", input.internalSecrets.invitationSigningSecret],
    ["MODEL_API_KEY", input.modelApiKey],
    ["POSTGRES_PASSWORD", input.internalSecrets.postgresPassword],
    ["PUBLIC_BASE_URL", `https://${input.hostname}`],
    ["TELEGRAM_BOT_TOKEN", input.telegramBotToken],
    ["TELEGRAM_BOT_USERNAME", input.telegramBotUsername],
    ["TELEGRAM_WEBHOOK_SECRET_TOKEN", input.internalSecrets.telegramWebhookSecretToken],
    [
      "WORKFLOW_POSTGRES_URL",
      `postgresql://osinara_workflow:${input.internalSecrets.workflowPostgresPassword}@postgres:5432/osinara_workflow`,
    ],
  ];
  if (input.groqApiKey !== null) values.push(["GROQ_API_KEY", input.groqApiKey]);
  return Buffer.from(
    `${values.map(([name, value]) => `${name}=${requireEnvironmentValue(value, name)}`).join("\n")}\n`,
    "utf8",
  );
}

function buildModelConfig(input: InstallationExecutionInput): Buffer {
  const config = buildModelProviderConfig(input.provider, {
    ...input.model,
    reasoningOptions: [...input.model.reasoningOptions],
  }, input.reasoning, input.groqApiKey !== null);
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Runs one initial install; migration start is the explicit point after which cleanup is unsafe. */
export function createHostInstallationExecutor(
  operations: HostInstallationOperations,
): (input: InstallationExecutionInput) => Promise<InstallationExecutionResult> {
  return async (input) => {
    requireExactArchiveChecksum(input);
    await operations.validateBundle(input.assets.archive);
    await operations.assertHostPrerequisites();
    const release = await operations.acquireLock();
    let completed = false;
    let primaryError: unknown;
    try {
      await operations.assertCleanState();
      const tls: HostTlsInput = { hostname: input.hostname, tlsMode: input.tlsMode };
      let stagingCompleted = false;
      try {
        await operations.stage({
          archive: input.assets.archive,
          environmentBytes: buildEnvironment(input),
          hostname: input.hostname,
          modelConfigBytes: buildModelConfig(input),
          releaseVersion: input.assets.version,
          tlsMode: input.tlsMode,
        });
        stagingCompleted = true;
        await operations.preflight(tls);
        await operations.pullImages(tls);
      } catch (error) {
        if (stagingCompleted) {
          try {
            await operations.rollbackPreparedState();
          } catch (rollbackError) {
            throw new InstallerError(
              "OSINARA_INSTALL_ROLLBACK_FAILED",
              "Подготовка не удалась, а созданные этой попыткой файлы не удалось удалить. Проверьте /opt/osinara вручную",
              { cause: rollbackError },
            );
          }
        }
        throw new InstallerError(
          "OSINARA_INSTALL_HOST_PREPARE_FAILED",
          "Не удалось подготовить сервер; созданные этой попыткой файлы удалены",
          { cause: error },
        );
      }

      try {
        // Marker durability is part of the irreversible boundary and must immediately precede Compose.
        await operations.markMigrationStarted();
        await operations.startApplication();
        // An external proxy is the operator's; the installer only waits for it to publish the edge.
        if (input.tlsMode === "managed") await operations.startTls();
        await operations.waitForPublicHttps(tls);
        const bootstrap = await operations.createOwnerBootstrap();
        await operations.configureWebhook({
          hostname: input.hostname,
          secretToken: input.internalSecrets.telegramWebhookSecretToken,
          token: input.telegramBotToken,
        });
        await operations.commit();
        completed = true;
        return bootstrap;
      } catch (error) {
        throw new InstallerError(
          "OSINARA_INSTALL_STATE_AMBIGUOUS",
          "Установка начала миграции, но не завершила все проверки. Не повторяйте её автоматически; выполните диагностику сервера",
          { cause: error },
        );
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await release();
      } catch (error) {
        // Lock cleanup is secondary: never replace a useful primary failure or a committed result.
        if (primaryError === undefined && !completed) throw error;
      }
    }
  };
}
