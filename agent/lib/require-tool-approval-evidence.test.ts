/**
 * Approval evidence binds an execution to the exact call a person confirmed.
 *
 * Constructs covered:
 * - A tool called directly is checked under its own name and input.
 * - A tool that runs inside the owner's settings door (#459) is checked under the door's call: the
 *   confirmation was recorded under the door's name and the input the model sent the door.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireToolExecutionApproval = vi.hoisted(() => vi.fn());
vi.mock("./telegram-hitl/approval-repository.js", () => ({
  telegramHitlApprovalRepository: { requireToolExecutionApproval },
}));
vi.mock("./sessions/session-context.js", () => ({ applicationSessionId: () => "app-session-1" }));

const { requireToolApprovalEvidence, withConfirmedCall } = await import("./require-tool-approval-evidence.js");
const { memoryOperationHash } = await import("./memory-record.js");

const CONTEXT = {
  callId: "call-1",
  session: { auth: { current: { attributes: { telegramUserId: "101" } } }, id: "agent-session-1" },
  toolName: "manage_profile_projection",
} as never;

describe("requireToolApprovalEvidence", () => {
  beforeEach(() => requireToolExecutionApproval.mockReset().mockResolvedValue(undefined));

  it("checks a direct call under its own name and input", async () => {
    const input = { action: "update", enabled: true, groupRef: "grp_1" };

    await requireToolApprovalEvidence(CONTEXT, "manage_profile_projection", input);

    expect(requireToolExecutionApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "call-1", toolInputHash: memoryOperationHash(input), toolName: "manage_profile_projection",
    }));
  });

  it("checks a call inside the owner's settings door under the door's confirmed call", async () => {
    const inner = { action: "update", enabled: true, groupRef: "grp_1" };
    const door = { call: inner, section: "group_profiles" };

    await requireToolApprovalEvidence(withConfirmedCall(CONTEXT, { input: door, toolName: "owner_settings" }), "manage_profile_projection", inner);

    expect(requireToolExecutionApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: "call-1", toolInputHash: memoryOperationHash(door), toolName: "owner_settings",
    }));
  });
});
