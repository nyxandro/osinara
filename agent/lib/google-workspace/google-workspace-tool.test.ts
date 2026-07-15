/**
 * Google Workspace connection-management tool policy tests.
 *
 * Constructs covered:
 * - The tool exposes setup/status/removal only, never Google API command passthrough.
 * - Disconnecting a durable workspace profile requires HITL.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import manageGoogleWorkspaceConnection, {
  googleWorkspaceConnectionStatus,
} from "../../tools/manage_google_workspace_connection.js";
import { GOOGLE_WORKSPACE_SCOPES } from "./google-workspace-config.js";

function approvalFor(input: Record<string, unknown>) {
  const approval = (manageGoogleWorkspaceConnection as unknown as {
    approval: (context: { toolInput: Record<string, unknown> }) => unknown;
  }).approval;
  return approval({ toolInput: input });
}

describe("manage_google_workspace_connection policy", () => {
  it("publishes connection actions without a generic API command", () => {
    const schema = z.toJSONSchema((manageGoogleWorkspaceConnection as unknown as {
      inputSchema: Parameters<typeof z.toJSONSchema>[0];
    }).inputSchema) as Record<string, unknown>;

    expect(schema.type).toBe("object");
    expect(schema.properties).toMatchObject({
      action: { enum: ["connect", "disconnect", "status"], type: "string" },
    });
    expect(schema.properties).not.toHaveProperty("command");
  });

  it("requires approval only to disconnect the durable profile", () => {
    expect(approvalFor({ action: "connect" })).toBe("not-applicable");
    expect(approvalFor({ action: "status" })).toBe("not-applicable");
    expect(approvalFor({ action: "disconnect" })).toBe("user-approval");
  });

  it("flags existing grants that must reconnect for newly required scopes", () => {
    const peopleApiScopes = [
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ];
    const status = googleWorkspaceConnectionStatus({
      displayName: "owner@example.com",
      scopes: GOOGLE_WORKSPACE_SCOPES.filter((scope) => !peopleApiScopes.includes(scope)),
    }, "personal");

    expect(status).toMatchObject({
      account: "owner@example.com",
      connected: true,
      reconnectRequired: true,
      scope: "personal",
    });
    expect(status.missingScopes).toEqual([
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
    ]);
  });

  it("keeps complete grants ready for native gws profile materialization", () => {
    expect(googleWorkspaceConnectionStatus({
      displayName: "owner@example.com",
      scopes: GOOGLE_WORKSPACE_SCOPES,
    }, "family")).toEqual({
      account: "owner@example.com",
      connected: true,
      scope: "family",
    });
  });
});
