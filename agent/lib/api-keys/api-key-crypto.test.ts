/**
 * Sandbox API key encryption tests.
 *
 * Constructs covered:
 * - A stored value decrypts back only with the same integration key; a changed ciphertext or a
 *   different key fails instead of yielding a wrong key.
 * - The usage token is stable for one integration key and reveals neither it nor the value key.
 * - A missing or malformed integration key fails fast with its own code.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  apiKeyUsageToken,
  decryptApiKeyValue,
  encryptApiKeyValue,
  requireIntegrationKey,
} from "./api-key-crypto.js";

const KEY = randomBytes(32).toString("base64");

describe("sandbox API key encryption", () => {
  it("decrypts a stored value with the same integration key", () => {
    const stored = encryptApiKeyValue("sk-live-1234567890abcdef", KEY);

    expect(stored.ciphertext).not.toContain("sk-live");
    expect(decryptApiKeyValue(stored, KEY)).toBe("sk-live-1234567890abcdef");
  });

  it("fails on a changed ciphertext or another integration key", () => {
    const stored = encryptApiKeyValue("sk-live-1234567890abcdef", KEY);
    const flipped = Buffer.from(stored.ciphertext, "base64");
    flipped[0] = flipped[0]! ^ 1;

    expect(() => decryptApiKeyValue({ ...stored, ciphertext: flipped.toString("base64") }, KEY)).toThrow();
    expect(() => decryptApiKeyValue(stored, randomBytes(32).toString("base64"))).toThrow();
  });

  it("derives a stable usage token that is neither the integration key nor its value key", () => {
    const token = apiKeyUsageToken(KEY);

    expect(apiKeyUsageToken(KEY)).toBe(token);
    expect(token).not.toBe(KEY);
    expect(apiKeyUsageToken(randomBytes(32).toString("base64"))).not.toBe(token);
  });

  it.each([undefined, "", "c2hvcnQ=", `${KEY}=`])("refuses the integration key %j", (value) => {
    expect(() => requireIntegrationKey(value)).toThrow(/AGENT_API_KEY_ENCRYPTION_KEY_(MISSING|INVALID)/u);
  });
});
