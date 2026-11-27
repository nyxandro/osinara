/**
 * Google OpenID UserInfo boundary tests.
 *
 * Constructs covered:
 * - Stable subject and verified email replace Calendar metadata as account identity.
 * - Unverified or malformed profiles are rejected.
 * - A timeout or a non-JSON answer becomes an application error with the original as cause.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { getGoogleAccountIdentity } from "./google-account-client.js";

describe("Google account identity client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a verified stable account identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: "owner@example.com",
      email_verified: true,
      sub: "google-subject-123",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGoogleAccountIdentity("access-secret")).resolves.toEqual({
      email: "owner@example.com",
      subject: "google-subject-123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      expect.objectContaining({ headers: { authorization: "Bearer access-secret" } }),
    );
  });

  it("rejects an unverified email", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: "owner@example.com",
      email_verified: false,
      sub: "google-subject-123",
    }), { status: 200 })));

    await expect(getGoogleAccountIdentity("access-secret")).rejects.toThrowError(
      /AGENT_GOOGLE_IDENTITY_RESPONSE_INVALID/,
    );
  });

  // fetch reports its timeout as a DOMException whose message is read-only.
  it.each(["request", "answer"] as const)("reports a timeout of the %s as a Google network failure", async (stage) => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (stage === "request") throw timeout;
      return new Response(new ReadableStream({ start: (controller) => controller.error(timeout) }), { status: 200 });
    }));

    const failure = await getGoogleAccountIdentity("access-secret").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("AGENT_GOOGLE_IDENTITY_NETWORK_FAILED");
    expect((failure as AppError).cause).toBe(timeout);
  });

  it("reports a refused profile request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_token",
    }), { status: 401 })));

    const failure = await getGoogleAccountIdentity("access-secret").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("AGENT_GOOGLE_IDENTITY_REQUEST_FAILED");
  });

  it("reports an answer that is not JSON as an invalid profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));

    const failure = await getGoogleAccountIdentity("access-secret").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("AGENT_GOOGLE_IDENTITY_RESPONSE_INVALID");
    expect((failure as AppError).cause).toBeInstanceOf(SyntaxError);
  });
});
