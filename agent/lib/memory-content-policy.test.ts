/**
 * Long-term memory content policy tests.
 *
 * Constructs covered:
 * - Credentials, private keys, one-time codes, and valid payment card numbers are rejected.
 * - Ordinary durable facts pass without transforming user content.
 */
import { describe, expect, it } from "vitest";

import { requireAllowedMemoryContent } from "./memory-content-policy.js";

describe("requireAllowedMemoryContent", () => {
  it.each([
    "Пароль: correct-horse-battery-staple",
    "API key sk_test_1234567890abcdef",
    "-----BEGIN PRIVATE KEY-----\nabc",
    "Одноразовый код: 123456",
    "Карта 4242 4242 4242 4242",
  ])("rejects prohibited secret content: %s", (content) => {
    expect(() => requireAllowedMemoryContent(content)).toThrowError(/AGENT_MEMORY_CONTENT_FORBIDDEN/);
  });

  it("returns an ordinary fact unchanged", () => {
    const content = "Пользователь предпочитает путешествовать поездом";

    expect(requireAllowedMemoryContent(content)).toBe(content);
  });
});
