/**
 * Google Workspace OAuth callback boundary tests.
 *
 * Constructs covered:
 * - State-bound grants persist OpenID identity rather than Calendar metadata.
 * - Explicit denial consumes the one-time authorization without token exchange.
 * - Callback completion repeats live management authorization before persistence.
 * - Every failure ends in a page that names the reason, never in an empty server error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../app-error.js";
import { createGoogleOAuthCallbackHandler } from "./google-oauth-callback.js";
import { GOOGLE_WORKSPACE_SCOPES } from "./google-workspace-config.js";

const claim = {
  actorUserId: "00000000-0000-4000-8000-000000000003",
  authorizationId: "00000000-0000-4000-8000-000000000001",
  familyId: "00000000-0000-4000-8000-000000000002",
  scope: "personal" as const,
  telegramUserId: "101",
  workspaceId: "00000000-0000-4000-8000-000000000004",
};

function dependencies() {
  return {
    claimAuthorization: vi.fn().mockResolvedValue(claim),
    completeAuthorization: vi.fn(async (_claim, _input, materialize: () => Promise<void>) => {
      await materialize();
      return { id: "account-1" };
    }),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: "access-secret",
      expiresInSeconds: 3600,
      refreshToken: "refresh-secret",
      scopes: GOOGLE_WORKSPACE_SCOPES,
    }),
    failAuthorization: vi.fn(),
    getAccountIdentity: vi.fn().mockResolvedValue({
      email: "owner@example.com",
      subject: "google-subject-123",
    }),
    getConfig: () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      redirectUri: "https://agent.example/v1/google-oauth/callback",
    }),
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    writeProfile: vi.fn(),
  };
}

describe("Google Workspace OAuth callback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists a state-bound OpenID account identity", async () => {
    const deps = dependencies();
    const handler = createGoogleOAuthCallbackHandler(deps);
    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Google Workspace подключён");
    expect(deps.completeAuthorization).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({
        displayName: "owner@example.com",
        externalAccountId: "google-subject-123",
      }),
      expect.any(Function),
    );
    expect(deps.writeProfile).toHaveBeenCalledWith(claim.workspaceId, {
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-secret",
      type: "authorized_user",
    });
  });

  it("does not persist or materialize a profile after management access is revoked", async () => {
    const deps = dependencies();
    deps.completeAuthorization.mockRejectedValue(new AppError(
      "AGENT_OWNER_REQUIRED",
      "Подключать и отключать общий Google Workspace может только владелец семьи",
    ));
    const handler = createGoogleOAuthCallbackHandler(deps);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "AGENT_OWNER_REQUIRED: Подключать и отключать общий Google Workspace может только владелец семьи.",
    );
    expect(deps.completeAuthorization).toHaveBeenCalled();
    expect(deps.writeProfile).not.toHaveBeenCalled();
    expect(deps.failAuthorization).toHaveBeenCalledWith(
      claim,
      "AGENT_GOOGLE_OAUTH_COMPLETION_FAILED",
    );
  });

  it("does not persist or materialize a grant with incomplete Workspace scopes", async () => {
    const deps = dependencies();
    deps.exchangeCode.mockResolvedValue({
      accessToken: "access-secret",
      expiresInSeconds: 3600,
      refreshToken: "refresh-secret",
      scopes: ["openid"],
    });
    const handler = createGoogleOAuthCallbackHandler(deps);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "AGENT_GOOGLE_SCOPE_INCOMPLETE: Google предоставил не все разрешения Workspace. " +
      "Запросите новую ссылку и подтвердите весь доступ.",
    );
    expect(deps.completeAuthorization).not.toHaveBeenCalled();
    expect(deps.writeProfile).not.toHaveBeenCalled();
  });

  it("records an explicit denial without exchanging a code", async () => {
    const deps = dependencies();
    const handler = createGoogleOAuthCallbackHandler(deps);
    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&error=access_denied",
    ));

    expect(response.status).toBe(400);
    expect(deps.failAuthorization).toHaveBeenCalledWith(claim, "AGENT_GOOGLE_OAUTH_DENIED");
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("terminates the claimed state after a provider completion failure", async () => {
    const deps = dependencies();
    deps.getAccountIdentity.mockRejectedValue(new Error("provider unavailable"));
    const handler = createGoogleOAuthCallbackHandler(deps);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    // The person gets a coded explanation; the technical detail stays in one log line.
    expect(response.status).toBe(500);
    const page = await response.text();
    expect(page).toContain("AGENT_GOOGLE_OAUTH_CALLBACK_FAILED: не удалось подключить Google Workspace.");
    expect(page).not.toContain("provider unavailable");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("provider unavailable");
    expect(deps.failAuthorization).toHaveBeenCalledWith(
      claim,
      "AGENT_GOOGLE_OAUTH_COMPLETION_FAILED",
    );
  });

  it("explains an expired or already used link instead of an empty server error", async () => {
    const deps = dependencies();
    deps.claimAuthorization.mockRejectedValue(new AppError(
      "AGENT_GOOGLE_OAUTH_STATE_INVALID",
      "Ссылка авторизации Google недействительна или истекла. Запросите новую ссылку в Telegram",
    ));
    const handler = createGoogleOAuthCallbackHandler(deps);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "AGENT_GOOGLE_OAUTH_STATE_INVALID: Ссылка авторизации Google недействительна или истекла. " +
      "Запросите новую ссылку в Telegram.",
    );
    expect(deps.exchangeCode).not.toHaveBeenCalled();
    expect(deps.failAuthorization).not.toHaveBeenCalled();
  });

  it("ends in a page even when the failure cannot be recorded", async () => {
    const deps = dependencies();
    deps.getAccountIdentity.mockRejectedValue(new Error("provider unavailable"));
    deps.failAuthorization.mockRejectedValue(new Error("database unavailable"));
    const handler = createGoogleOAuthCallbackHandler(deps);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("AGENT_GOOGLE_OAUTH_CALLBACK_FAILED");
    // Neither the original cause nor the lost status record disappears from the log.
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes("AGENT_GOOGLE_OAUTH_FAILURE_RECORD_FAILED") &&
      line.includes("database unavailable"))).toBe(true);
    expect(lines.some((line) => line.includes("AGENT_GOOGLE_OAUTH_CALLBACK_FAILED") &&
      line.includes("provider unavailable"))).toBe(true);
  });

  it("shows markup in an explanation as text", async () => {
    const deps = dependencies();
    deps.claimAuthorization.mockRejectedValue(new AppError("AGENT_GOOGLE_OAUTH_STATE_INVALID", "<b>ссылка</b> & код"));
    const handler = createGoogleOAuthCallbackHandler(deps);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(new Request(
      "https://agent.example/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes",
    ));

    expect(await response.text()).toContain("&lt;b&gt;ссылка&lt;/b&gt; &amp; код");
  });
});
