/**
 * Google Workspace OAuth HTTP boundary tests.
 *
 * Constructs covered:
 * - Consent requests exact identity and full user Workspace scopes.
 * - Authorization-code and refresh exchanges reject incomplete grants.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  GOOGLE_WORKSPACE_SCOPES,
  refreshGoogleAccessToken,
} from "./google-oauth-client.js";

const config = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://agent.example/eve/v1/google-oauth/callback",
};

describe("Google Workspace OAuth client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the exact full Workspace scope matrix and offline access", () => {
    const url = new URL(buildGoogleAuthorizationUrl(config, "csrf-state"));

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_WORKSPACE_SCOPES);
    expect(GOOGLE_WORKSPACE_SCOPES).toEqual(expect.arrayContaining([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/calendar",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/chat.spaces",
    ]));
  });

  it("exchanges and refreshes complete grants", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-secret",
        expires_in: 3600,
        refresh_token: "refresh-secret",
        scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
        token_type: "Bearer",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "new-access-secret",
        expires_in: 1800,
        scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
        token_type: "Bearer",
      }), { status: 200 })));

    await expect(exchangeGoogleAuthorizationCode(config, "authorization-code")).resolves
      .toMatchObject({ refreshToken: "refresh-secret", scopes: GOOGLE_WORKSPACE_SCOPES });
    await expect(refreshGoogleAccessToken(config, "refresh-secret")).resolves
      .toMatchObject({ accessToken: "new-access-secret", scopes: GOOGLE_WORKSPACE_SCOPES });
  });

  it("rejects grants missing any required Workspace scope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-secret",
      expires_in: 3600,
      refresh_token: "refresh-secret",
      scope: GOOGLE_WORKSPACE_SCOPES.filter((scope) => !scope.includes("spreadsheets")).join(" "),
      token_type: "Bearer",
    }), { status: 200 })));

    await expect(exchangeGoogleAuthorizationCode(config, "authorization-code")).rejects
      .toThrowError(/AGENT_GOOGLE_SCOPE_MISSING/);
  });
});
