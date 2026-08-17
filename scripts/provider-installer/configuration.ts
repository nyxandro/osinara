/**
 * Provider installer configuration primitives.
 *
 * Exports:
 * - `ADDRESS_MODE_OPTIONS` and `MODEL_PROVIDER_OPTIONS`: interactive choices without defaults.
 * - `requireCredential`: strict required secret validation.
 * - `generateInternalSecrets`: independent required internal credentials.
 * - `buildOwnerBootstrapOutput`: stable post-install owner deep-link contract.
 */
import type {
  AddressMode,
  InternalSecrets,
  ModelProvider,
  OwnerBootstrapOutput,
  PromptOption,
} from "./contracts.ts";
import { InstallerError } from "./errors.ts";

const INTERNAL_SECRET_MINIMUM_LENGTH = 32;
const BOOTSTRAP_CODE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/u;

export const ADDRESS_MODE_OPTIONS: readonly PromptOption<AddressMode>[] = [
  { label: "Автоматический адрес sslip.io", value: "sslip-io" },
  { label: "Собственный домен", value: "custom-domain" },
];

export const MODEL_PROVIDER_OPTIONS: readonly PromptOption<ModelProvider>[] = [
  { label: "DeepSeek", value: "deepseek" },
  { label: "MiniMax", value: "minimax" },
  { label: "NeuralDeep", value: "neuraldeep" },
  { label: "OpenCode Go", value: "opencode-go" },
  { label: "OpenRouter", value: "openrouter" },
];

export function requireCredential(value: string, label: string): string {
  const credential = value.trim();
  if (!credential || /[\s'\0]/u.test(credential)) {
    throw new InstallerError(
      "OSINARA_INSTALL_CREDENTIAL_INVALID",
      `Обязательное значение «${label}» не задано или содержит пробельные символы`,
    );
  }
  return credential;
}

export function generateInternalSecrets(
  generate: (purpose: string) => string,
): InternalSecrets {
  const secrets: InternalSecrets = {
    invitationSigningSecret: generate("invitation-signing-secret"),
    postgresPassword: generate("postgres-password"),
    telegramWebhookSecretToken: generate("telegram-webhook-secret-token"),
  };
  const values = Object.values(secrets);
  if (
    values.some((value) => value.length < INTERNAL_SECRET_MINIMUM_LENGTH || /\s/u.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_SECRET_GENERATION_FAILED",
      "Не удалось создать независимые внутренние секреты требуемой длины",
    );
  }
  return secrets;
}

export function buildOwnerBootstrapOutput(input: {
  botUsername: string;
  code: string;
  expiresAt: string;
}): OwnerBootstrapOutput {
  const expiresAt = new Date(input.expiresAt);
  if (
    !TELEGRAM_USERNAME_PATTERN.test(input.botUsername) ||
    !BOOTSTRAP_CODE_PATTERN.test(input.code) ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.toISOString() !== input.expiresAt
  ) {
    throw new InstallerError(
      "OSINARA_INSTALL_BOOTSTRAP_OUTPUT_INVALID",
      "Executor вернул некорректные данные первичной привязки владельца",
    );
  }
  return {
    code: "OSINARA_OWNER_BOOTSTRAP_READY",
    expiresAt: input.expiresAt,
    url: `https://t.me/${input.botUsername}?start=${encodeURIComponent(input.code)}`,
  };
}
