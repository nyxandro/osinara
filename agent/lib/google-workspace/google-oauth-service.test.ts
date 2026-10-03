/**
 * Google Workspace OAuth initiation tests.
 *
 * Constructs covered:
 * - A repeated connect while authorization is pending does not duplicate link delivery.
 * - Provider environment validation remains fail-fast before persistence or delivery.
 */
import { describe, expect, it, vi } from "vitest";

import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import { createGoogleWorkspaceAuthorizationStarter } from "./google-oauth-service.js";

const auth: GoogleIntegrationAuthorization = {
  familyId: "00000000-0000-4000-8000-000000000001",
  role: "owner",
  scope: "personal",
  telegramUserId: "101",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
};

describe("Google Workspace OAuth initiation", () => {
  it("does not deliver another link when the workspace already has a pending authorization", async () => {
    const deliverAuthorizationLink = vi.fn();
    const start = createGoogleWorkspaceAuthorizationStarter({
      buildAuthorizationUrl: vi.fn(),
      completeAuthorizationDelivery: vi.fn(),
      createAuthorization: vi.fn().mockResolvedValue({
        created: false,
        deliveryCompleted: true,
        expiresAt: "2026-08-05T12:10:00.000Z",
      }),
      deliverAuthorizationLink,
      getConfig: vi.fn().mockReturnValue({
        clientId: "client-id",
        clientSecret: "client-secret",
        encryptionKey: "encryption-key",
        redirectUri: "https://agent.example/v1/google-oauth/callback",
      }),
      randomState: vi.fn().mockReturnValue("state-with-at-least-32-random-bytes"),
    });

    await expect(start(auth, new Date("2026-08-05T12:00:00.000Z"))).resolves.toEqual({
      expiresAt: "2026-08-05T12:10:00.000Z",
      notice: "Ссылка для подключения Google Workspace уже отправлена в личный чат.",
      pending: true,
      ready: false,
    });
    expect(deliverAuthorizationLink).not.toHaveBeenCalled();
  });

  it("validates provider configuration before creating authorization state", async () => {
    const createAuthorization = vi.fn();
    const start = createGoogleWorkspaceAuthorizationStarter({
      buildAuthorizationUrl: vi.fn(),
      completeAuthorizationDelivery: vi.fn(),
      createAuthorization,
      deliverAuthorizationLink: vi.fn(),
      getConfig: vi.fn(() => {
        throw new Error("AGENT_GOOGLE_CONFIG_MISSING");
      }),
      randomState: vi.fn(),
    });

    await expect(start(auth)).rejects.toThrowError("AGENT_GOOGLE_CONFIG_MISSING");
    expect(createAuthorization).not.toHaveBeenCalled();
  });

  it("leaves an ambiguous started marker when private link delivery fails", async () => {
    const deliveryError = new Error("telegram unavailable");
    const completeAuthorizationDelivery = vi.fn();
    const start = createGoogleWorkspaceAuthorizationStarter({
      buildAuthorizationUrl: vi.fn().mockReturnValue("https://accounts.example/consent"),
      completeAuthorizationDelivery,
      createAuthorization: vi.fn().mockResolvedValue({
        authorizationId: "00000000-0000-4000-8000-000000000004",
        created: true,
        expiresAt: "2026-08-05T12:10:00.000Z",
      }),
      deliverAuthorizationLink: vi.fn().mockRejectedValue(deliveryError),
      getConfig: vi.fn().mockReturnValue({
        clientId: "client-id",
        clientSecret: "client-secret",
        encryptionKey: "encryption-key",
        redirectUri: "https://agent.example/v1/google-oauth/callback",
      }),
      randomState: vi.fn().mockReturnValue("state-with-at-least-32-random-bytes"),
    });

    await expect(start(auth, new Date("2026-08-05T12:00:00.000Z"))).rejects.toBe(deliveryError);
    expect(completeAuthorizationDelivery).not.toHaveBeenCalled();
  });

  it("does not claim an ambiguously delivered pending link was sent", async () => {
    const start = createGoogleWorkspaceAuthorizationStarter({
      buildAuthorizationUrl: vi.fn(),
      completeAuthorizationDelivery: vi.fn(),
      createAuthorization: vi.fn().mockResolvedValue({
        created: false,
        deliveryCompleted: false,
        expiresAt: "2026-08-05T12:10:00.000Z",
      }),
      deliverAuthorizationLink: vi.fn(),
      getConfig: vi.fn().mockReturnValue({
        clientId: "client-id",
        clientSecret: "client-secret",
        encryptionKey: "encryption-key",
        redirectUri: "https://agent.example/v1/google-oauth/callback",
      }),
      randomState: vi.fn().mockReturnValue("state-with-at-least-32-random-bytes"),
    });

    await expect(start(auth)).resolves.toMatchObject({
      notice: expect.stringContaining("результат не подтверждён"),
      pending: true,
    });
  });
});
