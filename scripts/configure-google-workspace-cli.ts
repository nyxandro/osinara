/**
 * Google Workspace environment setup CLI.
 *
 * Key constructs:
 * - `parseArguments`: validates initial JSON import and cross-environment sync modes.
 * - CLI entrypoint: applies configuration and prints only non-sensitive status metadata.
 */
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import {
  configureGoogleWorkspaceEnvironment,
  syncGoogleWorkspaceEnvironment,
  type ConfigureGoogleEnvironmentInput,
  type SyncGoogleEnvironmentInput,
} from "./configure-google-workspace.js";

const VALUE_ARGUMENT_NAMES = new Set([
  "--client-json",
  "--env-file",
  "--public-base-url",
  "--required-redirect-uri",
  "--source-env-file",
]);

type CliArguments =
  | ({ mode: "configure" } & ConfigureGoogleEnvironmentInput)
  | ({ mode: "sync" } & SyncGoogleEnvironmentInput);

function parseArguments(argumentsList: string[]): CliArguments {
  const values = new Map<string, string[]>();
  let deleteClientJson = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (argument === "--delete-client-json") {
      deleteClientJson = true;
      continue;
    }
    if (!VALUE_ARGUMENT_NAMES.has(argument)) {
      throw new Error(`AGENT_GOOGLE_SETUP_ARGUMENT_INVALID: Неизвестный аргумент ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`AGENT_GOOGLE_SETUP_ARGUMENT_MISSING: Не задано значение ${argument}`);
    }
    values.set(argument, [...values.get(argument) ?? [], value]);
    index += 1;
  }

  // Single-value arguments fail closed on both omission and accidental duplication.
  const single = (name: string): string => {
    const candidates = values.get(name);
    if (candidates?.length !== 1) {
      throw new Error(`AGENT_GOOGLE_SETUP_ARGUMENT_MISSING: Требуется один аргумент ${name}`);
    }
    return candidates[0]!;
  };
  const requiredRedirectUris = values.get("--required-redirect-uri");
  const sourceEnvFilePaths = values.get("--source-env-file");
  if (sourceEnvFilePaths) {
    if (
      sourceEnvFilePaths.length !== 1 ||
      values.has("--client-json") ||
      values.has("--required-redirect-uri") ||
      deleteClientJson
    ) {
      throw new Error(
        "AGENT_GOOGLE_SETUP_ARGUMENT_CONFLICT: --source-env-file нельзя совмещать с OAuth JSON",
      );
    }
    return {
      mode: "sync",
      envFilePath: single("--env-file"),
      publicBaseUrl: single("--public-base-url"),
      sourceEnvFilePath: sourceEnvFilePaths[0],
    };
  }
  if (!requiredRedirectUris?.length) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_ARGUMENT_MISSING: Требуется --required-redirect-uri",
    );
  }
  return {
    mode: "configure",
    clientJsonPath: single("--client-json"),
    deleteClientJson,
    envFilePath: single("--env-file"),
    publicBaseUrl: single("--public-base-url"),
    requiredRedirectUris,
  };
}

const argumentsInput = parseArguments(process.argv.slice(2));
const outputLines = ["Google Workspace environment configured."];
let encryptionKeyGenerated: boolean;
if (argumentsInput.mode === "configure") {
  const result = await configureGoogleWorkspaceEnvironment(argumentsInput);
  encryptionKeyGenerated = result.encryptionKeyGenerated;
  outputLines.push(`Project: ${result.projectId}`);
} else {
  const result = await syncGoogleWorkspaceEnvironment(argumentsInput);
  encryptionKeyGenerated = result.encryptionKeyGenerated;
}
await access(resolve(argumentsInput.envFilePath));
outputLines.push(
  `Environment: ${resolve(argumentsInput.envFilePath)}`,
  `Encryption key: ${encryptionKeyGenerated ? "generated" : "preserved"}`,
  "OAuth secrets were not printed.",
  "",
);
process.stdout.write(outputLines.join("\n"));
