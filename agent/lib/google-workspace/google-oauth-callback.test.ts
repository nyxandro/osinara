/**
 * Google Workspace OAuth callback boundary tests.
 *
 * Constructs covered:
 * - State-bound grants persist OpenID identity rather than Calendar metadata.
 * - Explicit denial consumes the one-time authorization without token exchange.
 */
import { describe, expect, it, vi } from "vitest";

import { createGoogleOAuthCallbackHandler } from "./google-oauth-callback.js";

const claim = {
  authorizationId: "00000000-0000-4000-8000-000000000001",
  familyId: "00000000-0000-4000-8000-000000000002",
  telegramChatId: "101",
  userId: "00000000-0000-4000-8000-000000000003",
};

function dependencies() {
  return {
    claimAuthorization: vi.fn().mockResolvedValue(claim),
    completeAuthorization: vi.fn().mockResolvedValue({ id: "account-1" }),
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: "access-secret",
      expiresInSeconds: 3600,
      refreshToken: "refresh-secret",
      scopes: ["scope"],
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
      redirectUri: "https://agent.example/eve/v1/google-oauth/callback",
    }),
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  };
}

describe("Google Workspace OAuth callback", () => {
  it("persists a state-bound OpenID account identity", async () => {
    const deps = dependencies();
    const handler = createGoogleOAuthCallbackHandler(deps);
    const response = await handler(new Request(
      "https://agent.example/eve/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Google Workspace подключён");
    expect(deps.completeAuthorization).toHaveBeenCalledWith(claim, expect.objectContaining({
      displayName: "owner@example.com",
      externalAccountId: "google-subject-123",
    }));
  });

  it("records an explicit denial without exchanging a code", async () => {
    const deps = dependencies();
    const handler = createGoogleOAuthCallbackHandler(deps);
    const response = await handler(new Request(
      "https://agent.example/eve/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&error=access_denied",
    ));

    expect(response.status).toBe(400);
    expect(deps.failAuthorization).toHaveBeenCalledWith(claim, "AGENT_GOOGLE_OAUTH_DENIED");
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("terminates the claimed state after a provider completion failure", async () => {
    const deps = dependencies();
    deps.getAccountIdentity.mockRejectedValue(new Error("provider unavailable"));
    const handler = createGoogleOAuthCallbackHandler(deps);

    await expect(handler(new Request(
      "https://agent.example/eve/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ))).rejects.toThrowError("provider unavailable");
    expect(deps.failAuthorization).toHaveBeenCalledWith(
      claim,
      "AGENT_GOOGLE_OAUTH_COMPLETION_FAILED",
    );
  });
});
