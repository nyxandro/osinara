/**
 * Secure first-owner bootstrap codes.
 *
 * Exports:
 * - Bootstrap constants: expiry and failed-attempt cap.
 * - `createBootstrapCode`: returns plaintext once and a persistable hash record.
 * - `verifyBootstrapCode`: constant-time validation with expiry and lockout.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const BOOTSTRAP_CODE_MAX_ATTEMPTS = 5;
export const BOOTSTRAP_CODE_TTL_MS = 15 * 60 * 1000;

export interface BootstrapCodeRecord {
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
}

function hashCode(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

export function createBootstrapCode(now: Date): {
  code: string;
  record: BootstrapCodeRecord;
} {
  // High-entropy base64url avoids ambiguous characters and makes a plain hash safe to persist.
  const code = randomBytes(32).toString("base64url");
  return {
    code,
    record: {
      codeHash: hashCode(code).toString("hex"),
      createdAt: new Date(now),
      expiresAt: new Date(now.getTime() + BOOTSTRAP_CODE_TTL_MS),
    },
  };
}

export function verifyBootstrapCode(input: {
  attempts: number;
  code: string;
  now: Date;
  record: BootstrapCodeRecord;
}): boolean {
  // Expired and locked records fail before cryptographic work and never become usable again.
  if (
    input.attempts >= BOOTSTRAP_CODE_MAX_ATTEMPTS ||
    input.now.getTime() > input.record.expiresAt.getTime()
  ) {
    return false;
  }

  // Both SHA-256 buffers have a fixed length, so timing-safe comparison cannot throw on length.
  const actualHash = hashCode(input.code);
  const expectedHash = Buffer.from(input.record.codeHash, "hex");
  return expectedHash.length === actualHash.length && timingSafeEqual(actualHash, expectedHash);
}
