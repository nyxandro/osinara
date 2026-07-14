/**
 * Safe Google Workspace OAuth environment importer.
 *
 * Exports:
 * - `GoogleOAuthClient`: validated Web OAuth client metadata without provider noise.
 * - `GoogleWorkspaceCredentials`: client credentials shared by configured environments.
 * - `ConfigureGoogleEnvironmentInput`: initial OAuth JSON import parameters.
 * - `SyncGoogleEnvironmentInput`: cross-environment synchronization parameters.
 * - `parseGoogleOAuthClient`: verifies downloaded JSON and every required callback URI.
 * - `readGoogleWorkspaceCredentials`: reads credentials from an already validated environment.
 * - `buildGoogleWorkspaceEnvironment`: preserves unrelated `.env` entries and encryption keys.
 * - `configureGoogleWorkspaceEnvironment`: atomically applies one environment configuration.
 * - `syncGoogleWorkspaceEnvironment`: securely copies validated credentials to another environment.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { z } from "zod";

const ENCRYPTION_KEY_BYTES = 32;
const GOOGLE_OAUTH_CALLBACK_PATH = "/eve/v1/google-oauth/callback";
const TARGET_ENVIRONMENT_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "INTEGRATION_TOKEN_ENCRYPTION_KEY",
  "PUBLIC_BASE_URL",
] as const;
const environmentLinePattern = /^([A-Z][A-Z0-9_]*)=(.*)$/u;

const oauthClientSchema = z.object({
  web: z.object({
    client_id: z.string().min(1).max(500),
    client_secret: z.string().min(1).max(500),
    project_id: z.string().min(1).max(255),
    redirect_uris: z.array(z.url()).min(1),
  }).strict().passthrough(),
}).strict().passthrough();

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  projectId: string;
  redirectUris: string[];
}

interface GoogleEnvironmentInput {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
}

export interface GoogleWorkspaceCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ConfigureGoogleEnvironmentInput {
  clientJsonPath: string;
  deleteClientJson: boolean;
  envFilePath: string;
  publicBaseUrl: string;
  requiredRedirectUris: string[];
}

export interface SyncGoogleEnvironmentInput {
  envFilePath: string;
  publicBaseUrl: string;
  sourceEnvFilePath: string;
}

function parseEnvironmentValues(source: string): {
  indexes: Map<string, number>;
  lines: string[];
  values: Map<string, string>;
} {
  const lines = source.split("\n");
  const indexes = new Map<string, number>();
  const values = new Map<string, string>();
  for (const [index, line] of lines.entries()) {
    const match = environmentLinePattern.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (indexes.has(key)) {
      throw new Error(`AGENT_GOOGLE_SETUP_ENV_DUPLICATE: ${key} указан в .env несколько раз`);
    }
    indexes.set(key, index);
    values.set(key, match[2]!);
  }
  return { indexes, lines, values };
}

function normalizedCallbackUri(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== GOOGLE_OAUTH_CALLBACK_PATH ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `AGENT_GOOGLE_SETUP_REDIRECT_INVALID: OAuth callback должен иметь вид https://host${GOOGLE_OAUTH_CALLBACK_PATH}`,
    );
  }
  return url.toString();
}

function normalizedPublicBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_PUBLIC_URL_INVALID: PUBLIC_BASE_URL должен быть HTTPS origin без пути",
    );
  }
  return url.origin;
}

function validateEncryptionKey(value: string): string {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== ENCRYPTION_KEY_BYTES || decoded.toString("base64") !== value) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_ENCRYPTION_KEY_INVALID: Ключ интеграций должен быть ровно 32 байта в base64",
    );
  }
  return value;
}

function safeEnvironmentValue(value: string, key: string): string {
  if (!value || /[\r\n\0]/u.test(value)) {
    throw new Error(`AGENT_GOOGLE_SETUP_ENV_VALUE_INVALID: Некорректное значение ${key}`);
  }
  return value;
}

export function parseGoogleOAuthClient(
  source: string,
  requiredRedirectUris: string[],
): GoogleOAuthClient {
  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch (error) {
    if (error instanceof Error) {
      error.message = "AGENT_GOOGLE_SETUP_CLIENT_INVALID: OAuth client JSON повреждён";
    }
    throw error;
  }
  const parsed = oauthClientSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_CLIENT_INVALID: Нужен OAuth client типа Web application",
    );
  }

  // Every environment callback must be registered before any secret reaches `.env`.
  const redirectUris = parsed.data.web.redirect_uris.map(normalizedCallbackUri);
  const required = requiredRedirectUris.map(normalizedCallbackUri);
  const missing = required.find((uri) => !redirectUris.includes(uri));
  if (missing) {
    throw new Error(
      `AGENT_GOOGLE_SETUP_REDIRECT_MISSING: В OAuth client отсутствует callback ${missing}`,
    );
  }
  return {
    clientId: parsed.data.web.client_id,
    clientSecret: parsed.data.web.client_secret,
    projectId: parsed.data.web.project_id,
    redirectUris,
  };
}

export function readGoogleWorkspaceCredentials(source: string): GoogleWorkspaceCredentials {
  const { values } = parseEnvironmentValues(source);
  const clientId = values.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = values.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_SOURCE_INCOMPLETE: Исходный .env не содержит настроенный Google OAuth client",
    );
  }
  return {
    clientId: safeEnvironmentValue(clientId, "GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: safeEnvironmentValue(clientSecret, "GOOGLE_OAUTH_CLIENT_SECRET"),
  };
}

export function buildGoogleWorkspaceEnvironment(
  source: string,
  input: GoogleEnvironmentInput,
  generateEncryptionKey: () => string = () => randomBytes(ENCRYPTION_KEY_BYTES).toString("base64"),
): { encryptionKeyGenerated: boolean; source: string } {
  const { indexes, lines, values } = parseEnvironmentValues(source);

  // Persisted credentials require the original key; generate one only for an unconfigured env.
  const existingEncryptionKey = values.get("INTEGRATION_TOKEN_ENCRYPTION_KEY");
  const encryptionKeyGenerated = !existingEncryptionKey;
  const encryptionKey = validateEncryptionKey(
    existingEncryptionKey || generateEncryptionKey(),
  );
  const replacements: Record<(typeof TARGET_ENVIRONMENT_KEYS)[number], string> = {
    GOOGLE_OAUTH_CLIENT_ID: safeEnvironmentValue(input.clientId, "GOOGLE_OAUTH_CLIENT_ID"),
    GOOGLE_OAUTH_CLIENT_SECRET: safeEnvironmentValue(
      input.clientSecret,
      "GOOGLE_OAUTH_CLIENT_SECRET",
    ),
    INTEGRATION_TOKEN_ENCRYPTION_KEY: encryptionKey,
    PUBLIC_BASE_URL: normalizedPublicBaseUrl(input.publicBaseUrl),
  };

  // Existing layout and unrelated secrets remain byte-stable apart from target value lines.
  const missingLines: string[] = [];
  for (const key of TARGET_ENVIRONMENT_KEYS) {
    const replacement = `${key}=${replacements[key]}`;
    const index = indexes.get(key);
    if (index === undefined) missingLines.push(replacement);
    else lines[index] = replacement;
  }
  if (missingLines.length) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push("# Google Workspace OAuth integration.", ...missingLines, "");
  }
  return { encryptionKeyGenerated, source: lines.join("\n") };
}

async function writeEnvironmentAtomically(envFilePath: string, source: string): Promise<void> {
  const temporaryPath = resolve(
    dirname(envFilePath),
    `.${basename(envFilePath)}.google-setup-${process.pid}`,
  );
  try {
    await writeFile(temporaryPath, source, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, envFilePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function configureGoogleWorkspaceEnvironment(
  input: ConfigureGoogleEnvironmentInput,
): Promise<{ encryptionKeyGenerated: boolean; projectId: string }> {
  const clientJsonPath = resolve(input.clientJsonPath);
  const envFilePath = resolve(input.envFilePath);
  const [clientMode, envMode] = await Promise.all([
    stat(clientJsonPath),
    stat(envFilePath),
  ]);
  if ((clientMode.mode & 0o777) !== 0o600 || (envMode.mode & 0o777) !== 0o600) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_FILE_MODE_INVALID: OAuth JSON и .env должны иметь права 0600",
    );
  }
  const [clientSource, envSource] = await Promise.all([
    readFile(clientJsonPath, "utf8"),
    readFile(envFilePath, "utf8"),
  ]);
  const client = parseGoogleOAuthClient(clientSource, input.requiredRedirectUris);
  const publicBaseUrl = normalizedPublicBaseUrl(input.publicBaseUrl);
  const environment = buildGoogleWorkspaceEnvironment(envSource, {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    publicBaseUrl,
  });

  // Same-directory rename is atomic, so a crash cannot leave a partially written secret file.
  await writeEnvironmentAtomically(envFilePath, environment.source);
  if (input.deleteClientJson) await rm(clientJsonPath);
  return {
    encryptionKeyGenerated: environment.encryptionKeyGenerated,
    projectId: client.projectId,
  };
}

export async function syncGoogleWorkspaceEnvironment(
  input: SyncGoogleEnvironmentInput,
): Promise<{ encryptionKeyGenerated: boolean }> {
  const sourceEnvFilePath = resolve(input.sourceEnvFilePath);
  const envFilePath = resolve(input.envFilePath);
  if (sourceEnvFilePath === envFilePath) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_SOURCE_TARGET_EQUAL: Исходный и целевой .env должны быть разными файлами",
    );
  }
  const [sourceMode, envMode] = await Promise.all([
    stat(sourceEnvFilePath),
    stat(envFilePath),
  ]);
  if ((sourceMode.mode & 0o777) !== 0o600 || (envMode.mode & 0o777) !== 0o600) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_FILE_MODE_INVALID: Исходный и целевой .env должны иметь права 0600",
    );
  }
  const [sourceEnvironment, targetEnvironment] = await Promise.all([
    readFile(sourceEnvFilePath, "utf8"),
    readFile(envFilePath, "utf8"),
  ]);
  const credentials = readGoogleWorkspaceCredentials(sourceEnvironment);
  const sourceEncryptionKey = parseEnvironmentValues(sourceEnvironment).values.get(
    "INTEGRATION_TOKEN_ENCRYPTION_KEY",
  );
  if (!sourceEncryptionKey) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_SOURCE_INCOMPLETE: Исходный .env не содержит ключ интеграций",
    );
  }
  validateEncryptionKey(sourceEncryptionKey);

  // Each deployment must encrypt its persisted grants with an independent key.
  const environment = buildGoogleWorkspaceEnvironment(targetEnvironment, {
    ...credentials,
    publicBaseUrl: input.publicBaseUrl,
  });
  const targetEncryptionKey = parseEnvironmentValues(environment.source).values.get(
    "INTEGRATION_TOKEN_ENCRYPTION_KEY",
  );
  if (targetEncryptionKey === sourceEncryptionKey) {
    throw new Error(
      "AGENT_GOOGLE_SETUP_ENCRYPTION_KEY_REUSED: Для другого окружения нужен отдельный ключ интеграций",
    );
  }
  await writeEnvironmentAtomically(envFilePath, environment.source);
  return { encryptionKeyGenerated: environment.encryptionKeyGenerated };
}
