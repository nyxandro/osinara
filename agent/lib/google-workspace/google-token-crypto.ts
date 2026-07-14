/**
 * Google OAuth token encryption boundary.
 *
 * Exports:
 * - `EncryptedGoogleToken`: persisted AES-256-GCM components.
 * - `requireGoogleTokenEncryptionKey`: strict base64 32-byte key validation.
 * - `encryptGoogleToken` and `decryptGoogleToken`: authenticated token protection.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EncryptedGoogleToken {
  authTag: string;
  ciphertext: string;
  nonce: string;
}

export function requireGoogleTokenEncryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== KEY_BYTES || key.toString("base64") !== encoded) {
    throw new Error(
      "AGENT_GOOGLE_ENCRYPTION_KEY_INVALID: Ключ интеграций должен быть ровно 32 байта в base64",
    );
  }
  return key;
}

export function encryptGoogleToken(token: string, encodedKey: string): EncryptedGoogleToken {
  if (!token) throw new Error("AGENT_GOOGLE_TOKEN_INVALID: Google вернул пустой OAuth token");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, requireGoogleTokenEncryptionKey(encodedKey), nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

export function decryptGoogleToken(token: EncryptedGoogleToken, encodedKey: string): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    requireGoogleTokenEncryptionKey(encodedKey),
    Buffer.from(token.nonce, "base64"),
    { authTagLength: AUTH_TAG_BYTES },
  );
  decipher.setAuthTag(Buffer.from(token.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(token.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  if (!plaintext) throw new Error("AGENT_GOOGLE_TOKEN_INVALID: Расшифрован пустой OAuth token");
  return plaintext;
}
