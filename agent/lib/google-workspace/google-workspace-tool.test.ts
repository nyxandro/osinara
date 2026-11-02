/**
 * Google Workspace connection-management tool policy tests.
 *
 * Constructs covered:
 * - The tool exposes setup/status/removal only, never Google API command passthrough.
 * - Connecting and disconnecting a workspace profile run without a person's confirmation in a live
 *   turn; a scenario run only reads the status.
 * - Status reports actual native-profile readiness and the reminders' calendar without changing state.
 * - Connect gives a new consent link when Google no longer honors the stored grant.
 * - Disconnect removes the reminders' calendar first and always finishes the mirror's part.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import manageGoogleWorkspaceConnection, {
  createGoogleWorkspaceConnectionManager,
  googleWorkspaceConnectionStatus,
} from "../tools/manage_google_workspace_connection.js";
import { GOOGLE_WORKSPACE_SCOPES } from "./google-workspace-config.js";

const auth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  scope: "personal" as const,
  telegramUserId: "101",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
};

function managerDependencies() {
  const account = {
    accessToken: "access-token",
    accessTokenExpiresAt: new Date("2026-08-05T12:00:00.000Z"),
    displayName: "owner@example.com",
    externalAccountId: "google-subject",
    id: "account-id",
    isDefault: true,
    refreshToken: "refresh-token",
    scopes: GOOGLE_WORKSPACE_SCOPES,
    status: "active" as const,
  };
  return {
    accessTokenAlive: vi.fn().mockResolvedValue(true),
    calendarMirror: {
      finishDisconnect: vi.fn(async () => undefined),
      removeBeforeDisconnect: vi.fn().mockResolvedValue("removed"),
      restore: vi.fn().mockResolvedValue({ calendar: "Осинара — напоминания", state: "catching_up" }),
      status: vi.fn().mockResolvedValue({ calendar: "Осинара — напоминания", state: "active" }),
    },
    disconnect: vi.fn(async (_auth, removeProfile: () => Promise<void>) => {
      await removeProfile();
      return true;
    }),
    getConfig: vi.fn().mockReturnValue({
      clientId: "client-id",
      clientSecret: "client-secret",
      encryptionKey: "encryption-key",
      redirectUri: "https://agent.example/v1/google-oauth/callback",
    }),
    profileExists: vi.fn().mockResolvedValue(true),
    removeProfile: vi.fn(),
    startAuthorization: vi.fn(),
    withProfileAccount: vi.fn(async (
      _auth,
      _encryptionKey,
      _management,
      operation: (value: typeof account) => Promise<unknown>,
    ) => await operation(account)),
    writeProfile: vi.fn(),
  };
}

function turnWith(scenario: Record<string, string>, kind = "conversation") {
  return {
    session: {
      auth: {
        current: {
          attributes: { telegramChatId: "101", telegramChatType: "private", telegramUserId: "101", ...scenario },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      turn: { id: "turn-1", kind, sequence: 1 },
    },
  } as never;
}

function approvalFor(input: Record<string, unknown>, turn: never) {
  return (manageGoogleWorkspaceConnection as unknown as {
    approval: (context: { session: unknown; toolInput: Record<string, unknown> }) => unknown;
  }).approval({ session: (turn as { session: unknown }).session, toolInput: input });
}

describe("manage_google_workspace_connection policy", () => {
  it("publishes connection actions without a generic API command", () => {
    const schema = z.toJSONSchema((manageGoogleWorkspaceConnection as unknown as {
      inputSchema: Parameters<typeof z.toJSONSchema>[0];
    }).inputSchema) as Record<string, unknown>;

    expect(schema.type).toBe("object");
    expect(schema.properties).toMatchObject({
      action: { enum: ["connect", "disconnect", "status", "restore_reminders_calendar"], type: "string" },
    });
    expect(schema.properties).not.toHaveProperty("command");
  });

  it("runs every connection action without waiting for a person's confirmation in a live turn", () => {
    for (const action of ["connect", "disconnect", "status", "restore_reminders_calendar"]) {
      expect(approvalFor({ action }, turnWith({}))).toBe("not-applicable");
    }
  });

  it("lets a scenario run only read the connection status", () => {
    for (const scenario of [
      turnWith({ scheduledRunId: "00000000-0000-4000-8000-000000000010" }, "scheduled"),
      turnWith({ telegramApprovalContinuation: "true" }, "wakeup"),
    ]) {
      expect(approvalFor({ action: "status" }, scenario)).toBe("not-applicable");
      for (const action of ["connect", "disconnect", "restore_reminders_calendar"]) {
        expect(approvalFor({ action }, scenario)).toMatchObject({
          reason: expect.stringContaining("AGENT_GOOGLE_WORKSPACE_SCENARIO_WRITE_FORBIDDEN"),
          type: "denied",
        });
      }
    }
  });

  it("does not report incomplete grants as connected or ready", () => {
    const peopleApiScopes = [
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ];
    const status = googleWorkspaceConnectionStatus({
      displayName: "owner@example.com",
      scopes: GOOGLE_WORKSPACE_SCOPES.filter((scope) => !peopleApiScopes.includes(scope)),
    }, "personal", true);

    expect(status).toMatchObject({
      account: "owner@example.com",
      connected: false,
      ready: false,
      reconnectRequired: true,
      scope: "personal",
    });
    expect(status.missingScopes).toEqual([
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ]);
  });

  it("reports complete materialized grants as ready", () => {
    expect(googleWorkspaceConnectionStatus({
      displayName: "owner@example.com",
      scopes: GOOGLE_WORKSPACE_SCOPES,
    }, "family", true)).toEqual({
      account: "owner@example.com",
      connected: true,
      ready: true,
      scope: "family",
    });
  });

  it("reports a complete grant without a credential profile as not ready", () => {
    expect(googleWorkspaceConnectionStatus({
      displayName: "owner@example.com",
      scopes: GOOGLE_WORKSPACE_SCOPES,
    }, "personal", false)).toEqual({
      account: "owner@example.com",
      connected: false,
      materializationRequired: true,
      ready: false,
      scope: "personal",
    });
  });

  it("keeps status strictly read-only", async () => {
    const deps = managerDependencies();
    deps.profileExists.mockResolvedValue(false);
    const manage = createGoogleWorkspaceConnectionManager(deps as never);

    await expect(manage({ action: "status" }, auth)).resolves.toMatchObject({
      connected: false,
      materializationRequired: true,
      ready: false,
    });
    expect(deps.writeProfile).not.toHaveBeenCalled();
    expect(deps.removeProfile).not.toHaveBeenCalled();
    expect(deps.startAuthorization).not.toHaveBeenCalled();
  });

  it("materializes an existing complete grant only at the explicit connect boundary", async () => {
    const deps = managerDependencies();
    deps.profileExists.mockResolvedValue(false);
    const manage = createGoogleWorkspaceConnectionManager(deps as never);

    await expect(manage({ action: "connect" }, auth)).resolves.toMatchObject({
      connected: true,
      ready: true,
    });
    expect(deps.withProfileAccount).toHaveBeenCalledWith(
      auth,
      "encryption-key",
      true,
      expect.any(Function),
    );
    expect(deps.writeProfile).toHaveBeenCalledWith(auth.workspaceId, {
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
      type: "authorized_user",
    });
    expect(deps.startAuthorization).not.toHaveBeenCalled();
  });

  it("keeps disconnect independent from provider environment while checking live management", async () => {
    const deps = managerDependencies();
    deps.getConfig.mockImplementation(() => {
      throw new Error("AGENT_GOOGLE_CONFIG_MISSING");
    });
    const manage = createGoogleWorkspaceConnectionManager(deps as never);

    await expect(manage({ action: "disconnect" }, auth)).resolves.toEqual({
      calendarCleanup: "removed",
      disconnected: true,
      ready: false,
      scope: "personal",
    });
    expect(deps.getConfig).not.toHaveBeenCalled();
    expect(deps.removeProfile).toHaveBeenCalledWith(auth.workspaceId);
    expect(deps.calendarMirror.removeBeforeDisconnect.mock.invocationCallOrder[0])
      .toBeLessThan(deps.disconnect.mock.invocationCallOrder[0]!);
    expect(deps.calendarMirror.finishDisconnect).toHaveBeenCalledWith(auth.workspaceId);
  });

  it("finishes the mirror's part of a disconnect that failed", async () => {
    const deps = managerDependencies();
    deps.disconnect.mockRejectedValueOnce(new Error("database down"));
    const manage = createGoogleWorkspaceConnectionManager(deps as never);

    await expect(manage({ action: "disconnect" }, auth)).rejects.toThrow("database down");
    expect(deps.calendarMirror.finishDisconnect).toHaveBeenCalledWith(auth.workspaceId);
  });

  it("gives a new consent link when Google no longer honors the stored grant", async () => {
    const deps = managerDependencies();
    deps.accessTokenAlive.mockResolvedValue(false);
    deps.startAuthorization.mockResolvedValue({ authorizationSent: true });
    const manage = createGoogleWorkspaceConnectionManager(deps as never);

    await expect(manage({ action: "connect" }, auth)).resolves.toEqual({ authorizationSent: true, ready: false });
    expect(deps.accessTokenAlive).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-id" }), "refresh-token");
    expect(deps.removeProfile).toHaveBeenCalledWith(auth.workspaceId);
    expect(deps.startAuthorization).toHaveBeenCalledWith(auth);
  });

  it("reports the reminders' calendar in the status", async () => {
    const deps = managerDependencies();
    const manage = createGoogleWorkspaceConnectionManager(deps as never);

    await expect(manage({ action: "status" }, auth)).resolves.toMatchObject({
      calendarMirror: { calendar: "Осинара — напоминания", state: "active" },
      connected: true,
    });
    expect(deps.calendarMirror.status).toHaveBeenCalledWith(auth.workspaceId);
  });

  it("brings back the reminders' calendar on request", async () => {
    const deps = managerDependencies();
    const manage = createGoogleWorkspaceConnectionManager(deps as never);

    await expect(manage({ action: "restore_reminders_calendar" }, auth)).resolves.toEqual({
      calendarMirror: { calendar: "Осинара — напоминания", state: "catching_up" },
      scope: "personal",
    });
    expect(deps.calendarMirror.restore).toHaveBeenCalledWith(auth);
    expect(deps.getConfig).not.toHaveBeenCalled();
  });
});
