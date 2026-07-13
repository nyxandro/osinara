/**
 * Google OAuth callback boundary tests.
 *
 * Constructs covered:
 * - State-bound grant completion and direct Telegram confirmation.
 * - Explicit user denial consumes the flow without exchanging a code.
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
    getConfig: () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      redirectUri: "https://agent.example/eve/v1/google-oauth/callback",
    }),
    getPrimaryCalendar: vi.fn().mockResolvedValue({
      accessRole: "owner",
      id: "owner@example.com",
      summary: "owner@example.com",
      timeZone: "Europe/Moscow",
    }),
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  };
}

describe("Google OAuth callback", () => {
  it("exchanges and persists a state-bound authorization", async () => {
    const deps = dependencies();
    const handler = createGoogleOAuthCallbackHandler(deps);
    const response = await handler(new Request(
      "https://agent.example/eve/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&code=auth-code",
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Google Calendar подключён");
    expect(deps.completeAuthorization).toHaveBeenCalledWith(claim, expect.objectContaining({
      accessToken: "access-secret",
      externalAccountId: "owner@example.com",
      refreshToken: "refresh-secret",
    }));
  });

  it("records an explicit denial without calling the token endpoint", async () => {
    const deps = dependencies();
    const handler = createGoogleOAuthCallbackHandler(deps);
    const response = await handler(new Request(
      "https://agent.example/eve/v1/google-oauth/callback?state=state-with-at-least-32-random-bytes&error=access_denied",
    ));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("AGENT_GOOGLE_OAUTH_DENIED");
    expect(deps.failAuthorization).toHaveBeenCalledWith(claim, "AGENT_GOOGLE_OAUTH_DENIED");
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("terminates a claimed state when completion fails after token exchange", async () => {
    const deps = dependencies();
    deps.getPrimaryCalendar.mockRejectedValue(new Error("provider unavailable"));
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
