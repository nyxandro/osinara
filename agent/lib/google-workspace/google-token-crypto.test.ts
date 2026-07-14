/**
 * Google Workspace credential encryption tests.
 *
 * Constructs covered:
 * - AES-256-GCM round trip with unique nonces.
 * - Wrong-key and tampered-ciphertext authentication failure.
 */
import { describe, expect, it } from "vitest";

import { decryptGoogleToken, encryptGoogleToken } from "./google-token-crypto.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("Google token encryption", () => {
  it("round-trips a token without deterministic ciphertext", () => {
    const first = encryptGoogleToken("refresh-secret", key);
    const second = encryptGoogleToken("refresh-secret", key);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(decryptGoogleToken(first, key)).toBe("refresh-secret");
  });

  it("rejects a wrong key and modified ciphertext", () => {
    const encrypted = encryptGoogleToken("refresh-secret", key);
    expect(() => decryptGoogleToken(encrypted, Buffer.alloc(32, 8).toString("base64"))).toThrow();
    const replacement = encrypted.ciphertext.startsWith("A") ? "B" : "A";
    expect(() => decryptGoogleToken({
      ...encrypted,
      ciphertext: `${replacement}${encrypted.ciphertext.slice(1)}`,
    }, key)).toThrow();
  });
});
