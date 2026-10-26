import { describe, expect, it } from "vitest";

import { approvalRequest, renderPendingApprovalsNote, resolveApprovalOutcome, stepInputResolved } from "./input-requests.js";

const APPROVAL = approvalRequest({ callId: "c1", input: { group: "g" }, toolName: "manage_profile_projection" }, "aitxt-AAAAAAAAAAAAAAAAAAAAAAAA");

describe("input requests", () => {
  it("writes the pending-approvals note with the reference wording", () => {
    expect(renderPendingApprovalsNote([APPROVAL])).toBe([
      "[Pending approvals]",
      "The following tool calls are awaiting approval and have not executed:",
      '{"requestId":"aitxt-AAAAAAAAAAAAAAAAAAAAAAAA","toolName":"manage_profile_projection"}',
    ].join("\n"));
    expect(renderPendingApprovalsNote([])).toBeUndefined();
  });

  it("generates approval ids the way AI SDK did", () => {
    expect(approvalRequest({ callId: "c", input: {}, toolName: "t" }).requestId).toMatch(/^aitxt-[A-Za-z0-9]{24}$/);
  });

  it.each([
    [undefined, { approved: false, reason: "Ignored because the user continued without responding." }],
    [{ optionId: "approve" }, { approved: true, reason: undefined }],
    [{ optionId: "cancel" }, { approved: false, reason: "Tool execution was denied." }],
    [{ optionId: "deny" }, { approved: false, reason: "Tool execution was denied." }],
    [{ optionId: "later" }, { approved: false, reason: "Invalid approval response." }],
  ])("reads the approval answer %j", (answer, outcome) => {
    expect(resolveApprovalOutcome(answer === undefined ? undefined : { requestId: "r", ...answer })).toEqual(outcome);
  });

  it("releases a step with approvals only when every approval is answered", () => {
    const second = approvalRequest({ callId: "c3", input: {}, toolName: "send" }, "aitxt-BBBBBBBBBBBBBBBBBBBBBBBB");
    const answered = (...ids: string[]) => new Map(ids.map((requestId) => [requestId, { optionId: "approve", requestId }]));

    expect(stepInputResolved([APPROVAL, second], answered(APPROVAL.requestId))).toBe(false);
    expect(stepInputResolved([APPROVAL, second], answered(APPROVAL.requestId, second.requestId))).toBe(true);
  });
});
