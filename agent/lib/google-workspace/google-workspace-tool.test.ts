/**
 * Google Workspace model-facing tool policy tests.
 *
 * Constructs covered:
 * - Provider-facing input JSON Schema is a flat object without root-level unions.
 * - OAuth initiation and known reads do not create redundant Eve approvals.
 * - Mutations, uploads, and unknown dynamic methods require HITL.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import googleWorkspace from "../../tools/google_workspace.js";

function approvalFor(input: Record<string, unknown>) {
  const approval = (googleWorkspace as unknown as {
    approval: (context: { toolInput: Record<string, unknown> }) => unknown;
  }).approval;
  return approval({ toolInput: input });
}

describe("google_workspace approval policy", () => {
  it("publishes a provider-compatible flat input schema", () => {
    const schema = z.toJSONSchema((googleWorkspace as unknown as {
      inputSchema: Parameters<typeof z.toJSONSchema>[0];
    }).inputSchema) as Record<string, unknown>;

    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema.properties).toMatchObject({
      action: { enum: ["connect", "execute"], type: "string" },
    });
  });

  it("requires approval for every possible external mutation", () => {
    expect(approvalFor({ action: "connect" })).toBe("not-applicable");
    expect(approvalFor({
      action: "execute",
      command: { method: "list", resourcePath: ["files"], service: "drive" },
    })).toBe("not-applicable");
    expect(approvalFor({
      action: "execute",
      command: { method: "create", resourcePath: ["files"], service: "drive" },
    })).toBe("user-approval");
    expect(approvalFor({
      action: "execute",
      command: { method: "futureMethod", resourcePath: ["files"], service: "drive" },
    })).toBe("user-approval");
    expect(approvalFor({
      action: "execute",
      command: { method: "get", resourcePath: ["files"], service: "drive" },
      upload: { contentType: "text/plain", path: "notes.txt", scope: "personal" },
    })).toBe("user-approval");
  });
});
