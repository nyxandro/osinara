/**
 * Runtime environment validation tests.
 *
 * Constructs covered:
 * - `requireRuntimeEnvironment`: requires the agent-model credential and permits optional voice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requireRuntimeEnvironment,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
  TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES,
} from "./config.js";

function stubRequiredEnvironment(): void {
  vi.stubEnv("MODEL_API_KEY", "agent-model-test-key");
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

  it("accepts complete voice and agent provider configuration", () => {
    stubRequiredEnvironment();

    expect(requireRuntimeEnvironment()).toMatchObject({
      MODEL_API_KEY: "agent-model-test-key",
      GROQ_API_KEY: "groq-test-key",
    });
  });

  it("allows voice transcription to remain unconfigured", () => {
    stubRequiredEnvironment();
    vi.stubEnv("GROQ_API_KEY", "");

    expect(requireRuntimeEnvironment().GROQ_API_KEY).toBeUndefined();
  });

  it("rejects missing credentials for the active agent model route", () => {
    stubRequiredEnvironment();
    vi.stubEnv("MODEL_API_KEY", "");

    expect(() => requireRuntimeEnvironment()).toThrowError(/MODEL_API_KEY/);
  });
});

describe("Telegram timeline limits", () => {
  it("retains five hundred thousand messages and admits one hundred per turn context", () => {
    expect(TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES).toBe(500_000);
    expect(TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES).toBe(100);
  });
});
