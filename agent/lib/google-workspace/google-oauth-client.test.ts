/**
 * Google Workspace OAuth HTTP boundary tests.
 *
 * Constructs covered:
 * - Consent requests exact identity and full user Workspace scopes.
 * - Authorization-code and refresh exchanges reject incomplete grants.
 * - A timeout or a non-JSON answer becomes an application error with the original as cause.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  GOOGLE_WORKSPACE_SCOPES,
  missingGoogleWorkspaceScopes,
  refreshGoogleAccessToken,
} from "./google-oauth-client.js";

const config = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://agent.example/v1/google-oauth/callback",
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
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/chat.spaces",
    ]));
  });

  it("reports missing scopes for grants created before People API access", () => {
    const peopleApiScopes = [
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ];
    const previousGrant = GOOGLE_WORKSPACE_SCOPES.filter((scope) => !peopleApiScopes.includes(scope));

    expect(missingGoogleWorkspaceScopes(previousGrant)).toEqual([
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ]);
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

  // fetch reports its timeout as a DOMException whose message is read-only.
  it.each(["request", "answer"] as const)("reports a timeout of the %s as a Google network failure", async (stage) => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (stage === "request") throw timeout;
      return new Response(new ReadableStream({ start: (controller) => controller.error(timeout) }), { status: 200 });
    }));

    const failure = await refreshGoogleAccessToken(config, "refresh-secret").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("AGENT_GOOGLE_OAUTH_NETWORK_FAILED");
    expect((failure as AppError).cause).toBe(timeout);
  });

  // The connection tool and the calendar mirror tell a revoked grant from a passing failure by this code.
  it("reports a revoked grant as expired access", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }), { status: 400 })));

    const failure = await refreshGoogleAccessToken(config, "refresh-secret").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("AGENT_GOOGLE_AUTH_EXPIRED");
  });

  it("reports an answer that is not JSON as an invalid Google answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));

    const failure = await refreshGoogleAccessToken(config, "refresh-secret").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("AGENT_GOOGLE_OAUTH_RESPONSE_INVALID");
    expect((failure as AppError).cause).toBeInstanceOf(SyntaxError);
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
