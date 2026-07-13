/**
 * Runtime environment validation tests.
 *
 * Constructs covered:
 * - `requireRuntimeEnvironment`: requires the active Groq credential.
 * - Retained CLIProxy credentials are optional but must be configured as a complete pair.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireRuntimeEnvironment } from "./config.js";

function stubRequiredEnvironment(): void {
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@postgres:5432/osinara_test");
  vi.stubEnv("GROQ_API_KEY", "groq-test-key");
  vi.stubEnv("INVITATION_SIGNING_SECRET", "12345678901234567890123456789012");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-test-token");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "osinara_test_bot");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-test-secret");
}

describe("requireRuntimeEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts Groq-only configuration while the retained route is inactive", () => {
    stubRequiredEnvironment();
    vi.stubEnv("CLI_PROXY_API_KEY", "");
    vi.stubEnv("CLI_PROXY_BASE_URL", "");

    expect(requireRuntimeEnvironment()).toMatchObject({ GROQ_API_KEY: "groq-test-key" });
  });

  it("rejects missing credentials for the active Groq route", () => {
    stubRequiredEnvironment();
    vi.stubEnv("GROQ_API_KEY", "");

    expect(() => requireRuntimeEnvironment()).toThrowError(/GROQ_API_KEY/);
  });

  it("rejects a partially configured retained CLIProxy route", () => {
    stubRequiredEnvironment();
    vi.stubEnv("CLI_PROXY_API_KEY", "");
    vi.stubEnv("CLI_PROXY_BASE_URL", "http://model-proxy:8317/v1");

    expect(() => requireRuntimeEnvironment()).toThrowError(/CLI_PROXY_API_KEY/);
  });
});
