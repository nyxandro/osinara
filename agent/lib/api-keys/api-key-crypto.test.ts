/**
 * Sandbox API key encryption tests.
 *
 * Constructs covered:
 * - A stored value decrypts back only with the same encryption key; a changed ciphertext or a
 *   different key fails instead of yielding a wrong key.
 * - The usage token is stable for one encryption key and reveals neither it nor the value key.
 * - The key is 32 bytes in base64 or in the installer's base64url; a missing or malformed key fails
 *   fast with its own code naming the variable.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  apiKeyUsageToken,
  decryptApiKeyValue,
  encryptApiKeyValue,
  requireApiKeyEncryptionKey,
} from "./api-key-crypto.js";

const KEY = randomBytes(32).toString("base64");

describe("sandbox API key encryption", () => {
  it("decrypts a stored value with the same encryption key", () => {
    const stored = encryptApiKeyValue("sk-live-1234567890abcdef", KEY);

    expect(stored.ciphertext).not.toContain("sk-live");
    expect(decryptApiKeyValue(stored, KEY)).toBe("sk-live-1234567890abcdef");
  });

  it("fails on a changed ciphertext or another encryption key", () => {
    const stored = encryptApiKeyValue("sk-live-1234567890abcdef", KEY);
    const flipped = Buffer.from(stored.ciphertext, "base64");
    flipped[0] = flipped[0]! ^ 1;

    expect(() => decryptApiKeyValue({ ...stored, ciphertext: flipped.toString("base64") }, KEY)).toThrow();
    expect(() => decryptApiKeyValue(stored, randomBytes(32).toString("base64"))).toThrow();
  });

  it("derives a stable usage token that is neither the encryption key nor its value key", () => {
    const token = apiKeyUsageToken(KEY);

    expect(apiKeyUsageToken(KEY)).toBe(token);
    expect(token).not.toBe(KEY);
    expect(apiKeyUsageToken(randomBytes(32).toString("base64"))).not.toBe(token);
  });

  it("accepts the key in the installer's base64url form", () => {
    const raw = randomBytes(32);
    const urlSafe = raw.toString("base64url");

    expect(requireApiKeyEncryptionKey(urlSafe).equals(raw)).toBe(true);
    expect(decryptApiKeyValue(encryptApiKeyValue("sk-live", urlSafe), raw.toString("base64"))).toBe("sk-live");
  });

  it.each([undefined, "", "c2hvcnQ=", `${KEY}=`])("refuses the encryption key %j", (value) => {
    expect(() => requireApiKeyEncryptionKey(value))
      .toThrow(/AGENT_API_KEY_ENCRYPTION_KEY_(MISSING|INVALID): SANDBOX_API_KEY_ENCRYPTION_KEY/u);
  });
});
