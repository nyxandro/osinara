/**
 * Approvals that wait for a person, and what the model reads once they are answered.
 *
 * Exports:
 * - `approvalRequest`: the request a parked call shows to the person.
 * - `renderPendingApprovalsNote`: the note written into history while approvals wait.
 * - `resolveApprovalOutcome`, `deniedOutput`: the tool result the model reads.
 * - `stepInputResolved`: whether the answers given so far release the parked step.
 *
 * One parked step is one batch: the batch rules apply to the step's calls. The texts are fixed;
 * the reference requests (`testing/reference-requests/`) pin the note and the denial result.
 * Contains code adapted from eve 0.40.0 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
import { createIdGenerator } from "ai";

import type { ToolResultOutput } from "../turn/tool-calls.js";
import type { InputRequest, InputResponse } from "./types.js";

export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution was denied.";
const IGNORED_INPUT_REASON = "Ignored because the user continued without responding.";
const INVALID_APPROVAL_MESSAGE = "Invalid approval response.";
const PENDING_APPROVALS_LABEL = "[Pending approvals]";

// AI SDK 7 generates approval ids this way; transferred histories already carry such ids.
const createApprovalId = createIdGenerator({ prefix: "aitxt", size: 24 });

interface ParkedCall {
  readonly callId: string;
  readonly input: Record<string, unknown>;
  readonly toolName: string;
}

export function approvalRequest(call: ParkedCall, requestId: string = createApprovalId()): InputRequest {
  return {
    action: { callId: call.callId, input: call.input, kind: "tool-call", toolName: call.toolName },
    kind: "tool-approval",
    options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
    prompt: `Approve tool call: ${call.toolName}`,
    requestId,
  };
}

export function renderPendingApprovalsNote(requests: readonly InputRequest[]): string | undefined {
  if (requests.length === 0) return undefined;
  return [
    PENDING_APPROVALS_LABEL,
    "The following tool calls are awaiting approval and have not executed:",
    ...requests.map((request) => JSON.stringify({ requestId: request.requestId, toolName: request.action.toolName })),
  ].join("\n");
}

export function resolveApprovalOutcome(response: InputResponse | undefined): {
  readonly approved: boolean;
  readonly reason: string | undefined;
} {
  if (response === undefined) return { approved: false, reason: IGNORED_INPUT_REASON };
  if (response.optionId === "approve") return { approved: true, reason: undefined };
  if (response.optionId === "cancel" || response.optionId === "deny") {
    return { approved: false, reason: TOOL_EXECUTION_DENIED_MESSAGE };
  }
  return { approved: false, reason: INVALID_APPROVAL_MESSAGE };
}

export function deniedOutput(reason: string | undefined): ToolResultOutput {
  return reason === undefined ? { type: "execution-denied" } : { type: "execution-denied", reason };
}

/** A parked step waits for an answer to every approval it raised. */
export function stepInputResolved(requests: readonly InputRequest[], responses: ReadonlyMap<string, InputResponse>): boolean {
  return requests.every((request) => responses.has(request.requestId));
}
