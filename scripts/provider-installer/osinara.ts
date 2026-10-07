#!/usr/bin/env node
/**
 * Osinara release CLI executable.
 *
 * Constructs:
 * - Invokes the stable command router.
 * - Wires install to immutable release, live provider, root host, TLS, webhook, and bootstrap adapters.
 * - Wires root/Linux operational and model-configuration commands for an installed host.
 */
import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";

import { applyModelConfiguration } from "../model-config/controller.ts";
import { ModelConfigError } from "../model-config/errors.ts";
import { CLI_COMMANDS, runCli } from "./cli.ts";
import type { CliOperation } from "./cli.ts";
import { runInteractiveConfigCommand } from "./config-command.ts";
import { InstallerError } from "./errors.ts";
import { validateGroqVoiceCredential } from "./groq-validation.ts";
import { createHostInstallationExecutor } from "./host-executor.ts";
import { DEPLOY_LOCK_PATH } from "./host-layout.ts";
import { withDeployLock } from "./installation-lock.ts";
import { runInteractiveInstaller } from "./installer.ts";
import { createPublicIpv4Sources, createTelegramGetMe } from "./network-adapters.ts";
import { createOperationalCommands } from "./operational-commands.ts";
import { createProductionHostOperations } from "./production-host-operations.ts";
import { createInstalledModelConfigDependencies } from "./production-model-config.ts";
import { createProductionOperationalCommands } from "./production-operational-commands.ts";
import { createProviderAdapters } from "./provider-adapters.ts";
import { createReleaseAssetsResolver } from "./release-assets.ts";
import { createTerminalPrompts } from "./terminal-prompts.ts";

const PROVIDER_CATALOG_TIMEOUT_MS = 10_000;
const PROVIDER_SMOKE_TIMEOUT_MS = 30_000;
const RELEASE_DOWNLOAD_TIMEOUT_MS = 120_000;
declare const OSINARA_INSTALL_ARCHIVE_SHA256: string;
declare const OSINARA_INSTALL_RELEASE_VERSION: string;

const install: CliOperation = async (args) => {
  if (args.length !== 0) {
    throw new InstallerError("OSINARA_CLI_ARGUMENT_INVALID", "Команда install не принимает аргументы");
  }
  const prompts = createTerminalPrompts();
  const providerAdapters = createProviderAdapters({
    catalogTimeoutMs: PROVIDER_CATALOG_TIMEOUT_MS,
    fetch: globalThis.fetch,
    smokeTimeoutMs: PROVIDER_SMOKE_TIMEOUT_MS,
  });
  const hostOperations = createProductionHostOperations();
  await hostOperations.assertHostPrerequisites();
  const executeInstallation = createHostInstallationExecutor(hostOperations);
  try {
    return await runInteractiveInstaller({
      executeInstallation,
      generateSecret: () => randomBytes(32).toString("base64url"),
      getTelegramMe: createTelegramGetMe(),
      listModels: providerAdapters.listModels,
      now: () => new Date(),
      prompts,
      publicIpv4Sources: createPublicIpv4Sources(),
      resolveIpv4: (hostname) => resolve4(hostname),
      resolveReleaseAssets: createReleaseAssetsResolver({
        archiveSha256: OSINARA_INSTALL_ARCHIVE_SHA256,
        fetch: globalThis.fetch,
        timeoutMs: RELEASE_DOWNLOAD_TIMEOUT_MS,
        version: OSINARA_INSTALL_RELEASE_VERSION,
      }),
      validateGroq: (apiKey) => validateGroqVoiceCredential({
        apiKey,
        fetch: globalThis.fetch,
        timeoutMs: PROVIDER_CATALOG_TIMEOUT_MS,
      }),
      validateModel: providerAdapters.validateModel,
    });
  } finally {
    prompts.close();
  }
};

const config: CliOperation = async (args) => {
  if (args.length !== 0) {
    throw new InstallerError("OSINARA_CLI_ARGUMENT_INVALID", "Команда config не принимает аргументы");
  }
  const prompts = createTerminalPrompts();
  const providerAdapters = createProviderAdapters({
    catalogTimeoutMs: PROVIDER_CATALOG_TIMEOUT_MS,
    fetch: globalThis.fetch,
    smokeTimeoutMs: PROVIDER_SMOKE_TIMEOUT_MS,
  });
  try {
    return await runInteractiveConfigCommand({
      apply: async (input) => {
        try {
          // The swap restarts the agent; during a release that would race the controller's backup.
          return await withDeployLock(
            DEPLOY_LOCK_PATH,
            () => applyModelConfiguration(createInstalledModelConfigDependencies(), input),
          );
        } catch (error) {
          if (error instanceof ModelConfigError) {
            throw new InstallerError(error.code, error.message.slice(error.code.length + 2));
          }
          throw error;
        }
      },
      listModels: providerAdapters.listModels,
      prompts,
      validateGroq: (apiKey) => validateGroqVoiceCredential({
        apiKey,
        fetch: globalThis.fetch,
        timeoutMs: PROVIDER_CATALOG_TIMEOUT_MS,
      }),
      validateModel: providerAdapters.validateModel,
    });
  } finally {
    prompts.close();
  }
};

const operationalCommands = createOperationalCommands(createProductionOperationalCommands());
const operations = Object.fromEntries(CLI_COMMANDS.map((command) => {
  if (command === "install") return [command, install];
  if (command === "config") return [command, config];
  return [command, operationalCommands[command]];
}));

/** Keeps the source entrypoint compatible with both native ESM and the CommonJS SEA bundle. */
async function main(): Promise<void> {
  // No command reports success until its immutable release/host adapter is wired and verified.
  process.exitCode = await runCli(process.argv.slice(2), {
    operations,
    writeError: (message) => process.stderr.write(`${message}\n`),
    writeOutput: (message) => process.stdout.write(`${message}\n`),
  });
}

void main();
