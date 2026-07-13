/**
 * Authenticated encryption for persisted Google OAuth credentials.
 *
 * Exports:
 * - `EncryptedGoogleToken`: base64 AES-256-GCM persistence fields.
 * - `encryptGoogleToken` and `decryptGoogleToken`: secret boundary helpers.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_BYTES = 16;
const ENCRYPTION_KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EncryptedGoogleToken {
  authTag: string;
  ciphertext: string;
  nonce: string;
}

export function requireGoogleTokenEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== ENCRYPTION_KEY_BYTES || key.toString("base64") !== value) {
    throw new Error(
      "AGENT_INTEGRATION_ENCRYPTION_KEY_INVALID: Ключ токенов должен быть ровно 32 байта в base64",
    );
  }
  return key;
}

export function encryptGoogleToken(token: string, keyValue: string): EncryptedGoogleToken {
  if (!token) {
    throw new Error("AGENT_GOOGLE_TOKEN_INVALID: Google вернул пустой OAuth token");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, requireGoogleTokenEncryptionKey(keyValue), nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

export function decryptGoogleToken(token: EncryptedGoogleToken, keyValue: string): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    requireGoogleTokenEncryptionKey(keyValue),
    Buffer.from(token.nonce, "base64"),
    { authTagLength: AUTH_TAG_BYTES },
  );
  decipher.setAuthTag(Buffer.from(token.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(token.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  if (!plaintext) {
    throw new Error("AGENT_GOOGLE_TOKEN_INVALID: Расшифрован пустой OAuth token");
  }
  return plaintext;
}
