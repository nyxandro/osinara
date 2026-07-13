/**
 * Google OAuth HTTP boundary tests.
 *
 * Constructs covered:
 * - Least-privilege offline consent URL and exact redirect URI.
 * - Authorization-code and refresh exchanges with safe provider failures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GOOGLE_CALENDAR_SCOPES,
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  refreshGoogleAccessToken,
} from "./google-oauth-client.js";

const config = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://agent.example/eve/v1/google-oauth/callback",
};

describe("Google OAuth client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds an offline consent URL with exact scopes and CSRF state", () => {
    const url = new URL(buildGoogleAuthorizationUrl(config, "csrf-state"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_CALENDAR_SCOPES);
    expect(url.searchParams.get("state")).toBe("csrf-state");
  });

  it("exchanges a code and requires an offline refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-secret",
      expires_in: 3600,
      refresh_token: "refresh-secret",
      scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      token_type: "Bearer",
    }), { status: 200 })));

    await expect(exchangeGoogleAuthorizationCode(config, "authorization-code")).resolves.toEqual({
      accessToken: "access-secret",
      expiresInSeconds: 3600,
      refreshToken: "refresh-secret",
      scopes: GOOGLE_CALENDAR_SCOPES,
    });
    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).not.toContain("undefined");
    expect(String(request.body)).toContain("grant_type=authorization_code");
  });

  it("refreshes once and rejects provider errors without token leakage", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "new-access",
        expires_in: 1800,
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
        token_type: "Bearer",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: "raw provider detail",
      }), { status: 400 })));

    await expect(refreshGoogleAccessToken(config, "refresh-secret")).resolves.toMatchObject({
      accessToken: "new-access",
      expiresInSeconds: 1800,
    });
    await expect(refreshGoogleAccessToken(config, "refresh-secret")).rejects.toThrowError(
      /AGENT_GOOGLE_AUTH_EXPIRED/,
    );
  });
});
