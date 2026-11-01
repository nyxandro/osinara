/**
 * Encryption of sandbox API key values, shared by the agent and the egress proxy.
 *
 * Exports:
 * - `INTEGRATION_KEY_ENVIRONMENT_NAME`: the integration key both processes read.
 * - `requireIntegrationKey`: strict base64 32-byte validation, failing fast when it is absent.
 * - `encryptApiKeyValue`, `decryptApiKeyValue`: AES-256-GCM under a key derived for values only;
 *   both fail with the missing-key code when the integration key is not configured.
 * - `apiKeyUsageToken`: the token the proxy shows when it reports usage to the agent.
 *
 * Both purposes use their own key derived from the integration key (HKDF), so a value ciphertext
 * never decrypts under the Google token key and the usage token reveals neither of them.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { ApiKeyEncryptedValue } from "./api-key-contract.js";

export const INTEGRATION_KEY_ENVIRONMENT_NAME = "INTEGRATION_TOKEN_ENCRYPTION_KEY";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const VALUE_KEY_INFO = "osinara-sandbox-api-key-value-v1";
const USAGE_TOKEN_INFO = "osinara-sandbox-api-key-usage-v1";

export function requireIntegrationKey(encoded: string | undefined): Buffer {
  if (!encoded) {
    throw new Error(`AGENT_API_KEY_ENCRYPTION_KEY_MISSING: ${INTEGRATION_KEY_ENVIRONMENT_NAME} is not configured`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== KEY_BYTES || key.toString("base64") !== encoded) {
    throw new Error(`AGENT_API_KEY_ENCRYPTION_KEY_INVALID: ${INTEGRATION_KEY_ENVIRONMENT_NAME} must be 32 bytes in base64`);
  }
  return key;
}

function derive(encodedKey: string | undefined, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", requireIntegrationKey(encodedKey), Buffer.alloc(0), info, KEY_BYTES));
}

export function encryptApiKeyValue(value: string, encodedKey: string | undefined): ApiKeyEncryptedValue {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, derive(encodedKey, VALUE_KEY_INFO), nonce, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

export function decryptApiKeyValue(value: ApiKeyEncryptedValue, encodedKey: string | undefined): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    derive(encodedKey, VALUE_KEY_INFO),
    Buffer.from(value.nonce, "base64"),
    { authTagLength: AUTH_TAG_BYTES },
  );
  decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function apiKeyUsageToken(encodedKey: string | undefined): string {
  return derive(encodedKey, USAGE_TOKEN_INFO).toString("base64url");
}
