/**
 * Bootstrap code tests.
 *
 * Constructs covered:
 * - `createBootstrapCode`: produces a non-persistable plaintext claim token.
 * - `verifyBootstrapCode`: enforces expiry and attempt limits.
 */
import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_CODE_MAX_ATTEMPTS,
  createBootstrapCode,
  verifyBootstrapCode,
} from "./bootstrap-code.js";

describe("bootstrap code", () => {
  it("stores only a hash and verifies the original code", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const generated = createBootstrapCode(now);

    expect(generated.code).not.toBe(generated.record.codeHash);
    expect(
      verifyBootstrapCode({ attempts: 0, code: generated.code, now, record: generated.record }),
    ).toBe(true);
  });

  it("rejects an expired code", () => {
    const createdAt = new Date("2026-07-11T12:00:00.000Z");
    const generated = createBootstrapCode(createdAt);
    const expiredAt = new Date(generated.record.expiresAt.getTime() + 1);

    expect(
      verifyBootstrapCode({ attempts: 0, code: generated.code, now: expiredAt, record: generated.record }),
    ).toBe(false);
  });

  it("rejects a code after the configured number of failed attempts", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const generated = createBootstrapCode(now);

    expect(
      verifyBootstrapCode({
        attempts: BOOTSTRAP_CODE_MAX_ATTEMPTS,
        code: generated.code,
        now,
        record: generated.record,
      }),
    ).toBe(false);
  });
});
