/**
 * Google OpenID UserInfo boundary tests.
 *
 * Constructs covered:
 * - Stable subject and verified email replace Calendar metadata as account identity.
 * - Unverified or malformed profiles are rejected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
