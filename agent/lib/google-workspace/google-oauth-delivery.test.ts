/**
 * Telegram delivery of the Google connection link.
 *
 * Constructs covered:
 * - A Telegram timeout becomes an application error with the timeout as cause.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { deliverGoogleAuthorizationLink } from "./google-oauth-delivery.js";

describe("Google connection link delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // fetch reports its timeout as a DOMException whose message is read-only.
  it("reports a Telegram timeout as a failed delivery", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:test-token");
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeout; }));

    const failure = await deliverGoogleAuthorizationLink(
      "1001",
      "https://accounts.google.com/o/oauth2/v2/auth?state=s",
      new Date("2027-02-03T09:10:00Z"),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("AGENT_GOOGLE_OAUTH_TELEGRAM_DELIVERY_FAILED");
    expect((failure as AppError).cause).toBe(timeout);
  });
});
