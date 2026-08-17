/**
 * Installer configuration tests.
 *
 * Constructs covered:
 * - Provider selection contract for all supported release variants.
 * - Internal secret generation and required credential validation.
 * - Owner bootstrap deep-link output with an explicit expiry contract.
 */
import { describe, expect, it, vi } from "vitest";

import {
  MODEL_PROVIDER_OPTIONS,
  buildOwnerBootstrapOutput,
  generateInternalSecrets,
  requireCredential,
} from "./configuration.js";

describe("provider installer configuration", () => {
  it("offers exactly the supported immutable provider variants", () => {
    expect(MODEL_PROVIDER_OPTIONS.map(({ value }) => value)).toEqual([
      "deepseek",
      "minimax",
      "neuraldeep",
      "opencode-go",
      "openrouter",
    ]);
  });

  it("generates each required internal secret independently", () => {
    const generate = vi.fn((purpose: string) => `secret-${purpose}-abcdefghijklmnopqrstuvwxyz`);
    const secrets = generateInternalSecrets(generate);

    expect(generate).toHaveBeenCalledTimes(3);
    expect(Object.keys(secrets).sort()).toEqual([
      "invitationSigningSecret",
      "postgresPassword",
      "telegramWebhookSecretToken",
    ]);
    expect(new Set(Object.values(secrets)).size).toBe(3);
  });

  it("rejects missing or whitespace-containing required credentials", () => {
    expect(() => requireCredential(" ", "model API key")).toThrowError(
      /OSINARA_INSTALL_CREDENTIAL_INVALID/,
    );
    expect(() => requireCredential("key with spaces", "model API key")).toThrowError(
      /OSINARA_INSTALL_CREDENTIAL_INVALID/,
    );
  });

  it("returns the stable owner bootstrap deep-link contract", () => {
    expect(
      buildOwnerBootstrapOutput({
        botUsername: "Osinara_Test_Bot",
        code: "bootstrap_secret-123",
        expiresAt: "2026-08-12T12:15:00.000Z",
      }),
    ).toEqual({
      code: "OSINARA_OWNER_BOOTSTRAP_READY",
      expiresAt: "2026-08-12T12:15:00.000Z",
      url: "https://t.me/Osinara_Test_Bot?start=bootstrap_secret-123",
    });
  });
});
