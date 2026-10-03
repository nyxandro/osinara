/**
 * Model-facing profile-projection policy tool tests.
 *
 * Constructs covered:
 * - Read-only policy listing does not require HITL evidence.
 * - Policy mutation consumes exact tool-call approval before repository access.
 */
import type { ToolContext } from "../runtime/tool.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPolicies, requireApprovalEvidence, updatePolicy } = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  requireApprovalEvidence: vi.fn(),
  updatePolicy: vi.fn(),
}));

vi.mock("./family-context.js", () => ({ requirePrivateTelegramOwner: vi.fn() }));
vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: () => ({ familyId: "family-1", role: "owner" }),
}));
vi.mock("./profile-projection-policy-repository.js", () => ({
  profileProjectionPolicyRepository: { list: listPolicies, update: updatePolicy },
}));
vi.mock("./require-tool-approval-evidence.js", () => ({
  requireToolApprovalEvidence: requireApprovalEvidence,
}));

import manageProfileProjection from "./tools/manage_profile_projection.js";

const GROUP_REF = "grp_0123456789abcdef0123456789abcdef";
const context = { callId: "projection-call-1" } as ToolContext;

describe("manage_profile_projection", () => {
  beforeEach(() => {
    listPolicies.mockReset();
    requireApprovalEvidence.mockReset();
    requireApprovalEvidence.mockResolvedValue(undefined);
    updatePolicy.mockReset();
  });

  it("lists policy without mutation approval evidence", async () => {
    listPolicies.mockResolvedValue([]);

    await manageProfileProjection.execute({ action: "list" }, context);

    expect(requireApprovalEvidence).not.toHaveBeenCalled();
    expect(listPolicies).toHaveBeenCalledOnce();
  });

  it("consumes exact approval evidence before updating policy", async () => {
    const input = { action: "update" as const, enabled: true, groupRef: GROUP_REF };
    updatePolicy.mockResolvedValue({ enabled: true, groupRef: GROUP_REF });

    await manageProfileProjection.execute(input, context);

    expect(requireApprovalEvidence).toHaveBeenCalledWith(
      context,
      "manage_profile_projection",
      input,
    );
    expect(requireApprovalEvidence.mock.invocationCallOrder[0])
      .toBeLessThan(updatePolicy.mock.invocationCallOrder[0]!);
  });
});
