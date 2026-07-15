/**
 * Google Workspace connection-management tool policy tests.
 *
 * Constructs covered:
 * - The tool exposes setup/status/removal only, never Google API command passthrough.
 * - Disconnecting a durable workspace profile requires HITL.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import manageGoogleWorkspaceConnection from "../../tools/manage_google_workspace_connection.js";

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
});
